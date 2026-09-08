import type {IDataset} from '../interfaces/IDataset.js';
import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  SelectResult,
  CreateResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';
import type {SparqlQueryResults} from './resultMapping.js';
import {
  selectToSparql,
  askToSparql,
  createToSparql,
  updateToSparql,
  updateWhereToSparql,
  deleteToSparql,
  deleteAllToSparql,
  deleteWhereToSparql,
} from './irToAlgebra.js';
import {
  mapSparqlSelectResult,
  mapSparqlAskResult,
  mapSparqlCreateResult,
  mapSparqlUpdateResult,
  isSparqlSelectResults,
} from './resultMapping.js';
import {generateEntityUri, type SparqlOptions} from './sparqlUtils.js';
import {lower} from '../queries/lower.js';

/**
 * Abstract base class for SPARQL-backed datasets.
 *
 * Handles the full pipeline: IR query → SPARQL string → execute → map results.
 * Subclasses only need to implement the two transport methods:
 * - `executeSparqlSelect` — send a SPARQL SELECT and return JSON results
 * - `executeSparqlUpdate` — send a SPARQL UPDATE (INSERT DATA / DELETE..INSERT / etc.)
 *
 * Example subclass (Fuseki):
 * ```ts
 * class FusekiDataset extends SparqlDataset {
 *   constructor(baseUrl: string, dataset: string) {
 *     super({ dataRoot: 'http://data.example.org' });
 *     this.queryEndpoint = `${baseUrl}/${dataset}/sparql`;
 *     this.updateEndpoint = `${baseUrl}/${dataset}/update`;
 *   }
 *   protected async executeSparqlSelect(sparql: string) {
 *     const res = await fetch(this.queryEndpoint, { ... });
 *     return res.json();
 *   }
 *   protected async executeSparqlUpdate(sparql: string) {
 *     await fetch(this.updateEndpoint, { ... });
 *   }
 * }
 * ```
 */
export abstract class SparqlDataset implements IDataset {
  protected options?: SparqlOptions;

  constructor(options?: SparqlOptions) {
    this.options = options;
  }

  /**
   * Send a SPARQL SELECT/ASK/CONSTRUCT query and return the parsed
   * SPARQL JSON Results (application/sparql-results+json).
   *
   * The return type is the union of both response shapes a query endpoint can
   * produce: a SELECT result set (`results.bindings`) or an ASK answer
   * (`boolean`). A subclass may still declare the narrower `SparqlJsonResults` —
   * a return type is covariant, so existing implementations stay valid.
   */
  protected abstract executeSparqlSelect(
    sparql: string,
  ): Promise<SparqlQueryResults>;

  /**
   * Send a SPARQL UPDATE request (INSERT DATA, DELETE/INSERT, etc.).
   * No return value — the update is fire-and-forget at the SPARQL level.
   */
  protected abstract executeSparqlUpdate(sparql: string): Promise<void>;

  async selectQuery(query: SelectQuery): Promise<SelectResult> {
    const ir = lower(query);
    const sparql = selectToSparql(ir, this.options);
    const json = await this.executeSparqlSelect(sparql);
    if (!isSparqlSelectResults(json)) {
      throw new Error(
        'Expected a SPARQL SELECT result set, got an ASK response. The endpoint ' +
        'did not answer the SELECT query that was sent.',
      );
    }
    return mapSparqlSelectResult(json, ir);
  }

  /**
   * Answer an ask query — emitted as `ASK WHERE { … }`.
   *
   * An {@link AskQuery} carries only a pattern, so there is nothing to normalise
   * away here. A query with no shape lowers to `ASK { <iri> ?p ?o }` — existence
   * of the node under any type or none. Errors reject; never reported as `false`.
   */
  async askQuery(query: AskQuery): Promise<boolean> {
    const ir = lower(query);
    const sparql = askToSparql(ir, this.options);
    const json = await this.executeSparqlSelect(sparql);
    return mapSparqlAskResult(json);
  }

  async createQuery(query: CreateQuery): Promise<CreateResult> {
    const ir = lower(query);
    const uri = ir.data.id || generateEntityUri(ir.data.shape, this.options);
    ir.data.id = uri;
    const sparql = createToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return mapSparqlCreateResult(uri, ir);
  }

  async updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    const ir = lower(query);
    if (ir.kind === 'update_where') {
      const sparql = updateWhereToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {id: ''} as UpdateResult;
    }
    const sparql = updateToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return mapSparqlUpdateResult(ir);
  }

  async deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    const ir = lower(query);
    if (ir.kind === 'delete_all') {
      const sparql = deleteAllToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {deleted: [], count: 0};
    }
    if (ir.kind === 'delete_where') {
      const sparql = deleteWhereToSparql(ir, this.options);
      await this.executeSparqlUpdate(sparql);
      return {deleted: [], count: 0};
    }
    const sparql = deleteToSparql(ir, this.options);
    await this.executeSparqlUpdate(sparql);
    return {
      deleted: ir.ids,
      count: ir.ids.length,
    };
  }

  /**
   * Execute a raw SPARQL query string directly against the dataset.
   * Defaults to SELECT; pass `'update'` for INSERT/DELETE operations.
   */
  async rawQuery(
    sparql: string,
    mode?: 'query' | 'update',
  ): Promise<SparqlQueryResults | void> {
    if (mode === 'update') {
      return this.executeSparqlUpdate(sparql);
    }
    return this.executeSparqlSelect(sparql);
  }
}

// Backwards-compatibility re-export — remove once all consumers are updated.
export {SparqlDataset as SparqlStore};
