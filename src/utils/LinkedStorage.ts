import {CoreMap} from '../collections/CoreMap.js';
import {CoreSet} from '../collections/CoreSet.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import {setQueryDispatch} from '../queries/queryDispatch.js';
import {getShapeClass} from './ShapeClass.js';
import type {NodeShape} from '../shapes/SHACL.js';

// plan-011 — count physical evaluations of THIS module on the one shared
// global object. With the single-loader fix there should be exactly one copy;
// the single-instance guard in backend.ts reports this count if storage config
// ever lands on a different copy. Deliberately avoids Date/Math.random
// (unavailable / non-deterministic per repo constraints).
const linkedStorageGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);
linkedStorageGlobal.__linkedStorageInstanceCount =
  (linkedStorageGlobal.__linkedStorageInstanceCount ?? 0) + 1;

/**
 * Primary routing layer (arch-04 §The IDataset abstraction).
 *
 * Resolves an incoming Linked Query to the IDataset that should handle it,
 * based on the query's target shape. Composite IDatasets (gateways, routers,
 * forwarders, resolvers) plug in here just like storage IDatasets do.
 *
 * The "Dataset" naming aligns with the IDataset contract. Earlier "Store"
 * names were renamed in phase-1 — see docs/plans/002-phase-1-create-user-project-flow.md.
 */
export abstract class LinkedStorage {
  private static defaultDataset?: IDataset;
  private static shapeToDataset: CoreMap<Function, IDataset> =
    new CoreMap();

  /** plan-011 — how many physical copies of this module have evaluated. */
  static getLoadedInstanceCount(): number {
    return linkedStorageGlobal.__linkedStorageInstanceCount ?? 0;
  }

  static isInitialised() {
    return !!this.defaultDataset;
  }

  /** The catch-all IDataset for shapes with no explicit mapping. */
  static getDefaultDataset() {
    return this.defaultDataset;
  }

  /** Set the default IDataset (catch-all for shapes with no explicit mapping). */
  static setDefaultDataset(dataset: IDataset) {
    this.defaultDataset = dataset;
    if (this.defaultDataset?.init) {
      this.defaultDataset.init();
    }
    setQueryDispatch({
      selectQuery: (q) => this.selectQuery(q),
      createQuery: (q) => this.createQuery(q),
      updateQuery: (q) => this.updateQuery(q),
      deleteQuery: (q) => this.deleteQuery(q),
    });
  }

  /** Pin one or more shape classes to a specific IDataset implementer. */
  static setDatasetForShapes(dataset: IDataset, ...shapeClasses: Function[]) {
    shapeClasses.forEach((shapeClass) => {
      this.shapeToDataset.set(shapeClass, dataset);
    });
  }

  /** Every IDataset known to the primary router (default + all pinned). */
  static getDatasets(): CoreSet<IDataset> {
    const datasets = new CoreSet<IDataset>();
    if (this.defaultDataset) {
      datasets.add(this.defaultDataset);
    }
    this.shapeToDataset.forEach((dataset) => datasets.add(dataset));
    return datasets;
  }

  /** Read-only view of the shape→IDataset map. */
  static getShapeToDatasetMap(): CoreMap<Function, IDataset> {
    return this.shapeToDataset;
  }

  /** Resolve the IDataset for a given shape class. Walks the prototype chain. */
  static getDatasetForShapeClass(shapeClass?: Function | null): IDataset {
    let current: Function | null = shapeClass ?? null;
    while (typeof current === 'function') {
      const dataset = this.shapeToDataset.get(current);
      if (dataset) {
        return dataset;
      }
      const parent = Object.getPrototypeOf(current);
      if (parent === Function.prototype || parent === null) break;
      current = parent;
    }
    return this.defaultDataset;
  }

  private static resolveDatasetForQueryShape(
    shape?: string | Function | NodeShape | null,
  ): IDataset {
    if (!shape) {
      return this.defaultDataset;
    }
    if (typeof shape === 'function') {
      return this.getDatasetForShapeClass(shape);
    }
    if (typeof shape === 'string') {
      const shapeClass = getShapeClass(shape);
      return this.getDatasetForShapeClass(shapeClass);
    }
    // NodeShape (the closed query's `shape` accessor) — resolve via its IRI.
    if (typeof shape === 'object' && 'id' in shape) {
      const shapeClass = getShapeClass((shape as {id: string}).id);
      return this.getDatasetForShapeClass(shapeClass);
    }
    return this.defaultDataset;
  }

  static selectQuery<ResultType>(query: SelectQuery): Promise<ResultType> {
    if (!query?.shape) {
      return Promise.reject(
        new Error(
          'Invalid select query passed to LinkedStorage.selectQuery(): missing shape.',
        ),
      );
    }
    const dataset = this.resolveDatasetForQueryShape(query.shape);
    if (!dataset?.selectQuery) {
      return Promise.reject(
        new Error('No query dataset configured. Call LinkedStorage.setDefaultDataset().'),
      );
    }
    return dataset.selectQuery(query) as Promise<ResultType>;
  }

  static updateQuery<ResponseType>(query: UpdateQuery): Promise<ResponseType> {
    const dataset = this.resolveDatasetForQueryShape(query?.shape);
    if (!dataset?.updateQuery) {
      return Promise.reject(
        new Error('No update handler configured on the query dataset.'),
      );
    }
    return dataset.updateQuery(query) as Promise<ResponseType>;
  }

  static createQuery<ResponseType>(query: CreateQuery): Promise<ResponseType> {
    const dataset = this.resolveDatasetForQueryShape(query?.shape);
    if (!dataset?.createQuery) {
      return Promise.reject(
        new Error('No create handler configured on the query dataset.'),
      );
    }
    return dataset.createQuery(query) as Promise<ResponseType>;
  }

  static deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    const dataset = this.resolveDatasetForQueryShape(query?.shape);
    if (!dataset?.deleteQuery) {
      return Promise.reject(
        new Error('No delete handler configured on the query dataset.'),
      );
    }
    return dataset.deleteQuery(query);
  }
}
