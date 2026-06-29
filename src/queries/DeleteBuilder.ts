import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {resolveShape} from './resolveShape.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {NodeId} from './MutationQuery.js';
import {getQueryDispatch} from './queryDispatch.js';
import {WIRE_VERSION, assertWireVersion} from './wireVersion.js';
import type {NodeShape} from '../shapes/SHACL.js';
import {type WhereClause, type WherePath, processWhereClause} from './SelectQuery.js';
import {type DeleteMutationJSON} from './MutationSerialization.js';
import {serializeWherePath, deserializeWherePath} from './QueryBuilderSerialization.js';
import type {DeleteLowerSpec} from './mutationLowerSpec.js';
import {PendingQueryContext, asContextRef} from './QueryContext.js';
import {encodeContextRef, isContextRefJSON} from './ContextRef.js';

type DeleteMode = 'ids' | 'all' | 'where';

/** A node to delete: a concrete id, a `{id}` ref, or a live query-context reference. */
export type DeleteId = NodeId | PendingQueryContext;

/**
 * Internal state bag for DeleteBuilder.
 */
interface DeleteBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  ids?: DeleteId[];
  mode?: DeleteMode;
  whereFn?: WhereClause<S>;
  /** A pre-resolved where path (used by fromJSON; no live callback). */
  where?: WherePath;
}

/**
 * An immutable, fluent builder for delete mutations.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await DeleteBuilder.from(Person, {id: '...'});
 * await DeleteBuilder.from(Person).all();  // returns void
 * ```
 *
 * R is the resolved type: DeleteResponse for ID-based, void for bulk operations.
 */
export class DeleteBuilder<S extends Shape = Shape, R = DeleteResponse>
  implements PromiseLike<R>, Promise<R>
{
  private readonly _shape: ShapeConstructor<S>;
  private readonly _ids?: DeleteId[];
  private readonly _mode?: DeleteMode;
  private readonly _whereFn?: WhereClause<S>;
  private readonly _where?: WherePath;

  private constructor(init: DeleteBuilderInit<S>) {
    this._shape = init.shape;
    this._ids = init.ids;
    this._mode = init.mode;
    this._whereFn = init.whereFn;
    this._where = init.where;
  }

  private clone(overrides: Partial<DeleteBuilderInit<S>> = {}): DeleteBuilder<S, any> {
    return new DeleteBuilder<S>({
      shape: this._shape,
      ids: this._ids,
      mode: this._mode,
      whereFn: this._whereFn,
      where: this._where,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  static from<S extends Shape>(
    shape: ShapeConstructor<S> | string,
    ids?: DeleteId | DeleteId[],
  ): DeleteBuilder<S, DeleteResponse> {
    const resolved = resolveShape<S>(shape);
    if (ids !== undefined) {
      // Normalize any context reference (unset PendingQueryContext or a resolved
      // context shape) to a {$ctx} marker so set/unset behave identically.
      const idsArray = (Array.isArray(ids) ? ids : [ids]).map(
        (id) => asContextRef(id) ?? id,
      );
      return new DeleteBuilder<S>({shape: resolved, ids: idsArray, mode: 'ids'});
    }
    return new DeleteBuilder<S>({shape: resolved});
  }

  /** Reconstruct a DeleteBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: DeleteMutationJSON): DeleteBuilder {
    assertWireVersion(json.v);
    const resolved = resolveShape(json.shape);
    if (json.mode === 'ids') {
      // A `{$ctx}` id rehydrates as a live context ref (resolved at lower).
      const ids: DeleteId[] = json.ids.map((id) =>
        isContextRefJSON(id) ? new PendingQueryContext(id.$ctx) : {id},
      );
      return new DeleteBuilder({shape: resolved, ids, mode: 'ids'});
    }
    if (json.mode === 'all') {
      return new DeleteBuilder({shape: resolved, mode: 'all'});
    }
    const where = deserializeWherePath(resolved.shape, json.where);
    return new DeleteBuilder({shape: resolved, mode: 'where', where});
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Delete all instances of this shape type. Returns void. */
  all(): DeleteBuilder<S, void> {
    return this.clone({mode: 'all', ids: undefined, whereFn: undefined}) as DeleteBuilder<S, void>;
  }

  /** Delete instances matching a condition. Returns void. */
  where(fn: WhereClause<S>): DeleteBuilder<S, void> {
    return this.clone({mode: 'where', whereFn: fn, ids: undefined}) as DeleteBuilder<S, void>;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'delete' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShape {
    return this._shape.shape;
  }


  /** @internal The IR-free lowering spec consumed by `lower()`. Validates inputs. */
  _lowerSpec(): DeleteLowerSpec<S> {
    const mode = this._mode || (this._ids ? 'ids' : undefined);

    if (mode === 'all') {
      return {shapeClass: this._shape, mode: 'all'};
    }

    if (mode === 'where') {
      const wherePath =
        this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('DeleteBuilder.where() requires a condition callback.');
      }
      return {shapeClass: this._shape, mode: 'where', wherePath};
    }

    // Default: ID-based delete
    if (!this._ids || this._ids.length === 0) {
      throw new Error(
        'DeleteBuilder requires at least one ID to delete. Use DeleteBuilder.from(shape, ids), .all(), or .where().',
      );
    }
    return {shapeClass: this._shape, mode: 'ids', ids: this._ids};
  }

  /** Serialize this delete mutation to lightweight DSL-JSON. */
  toJSON(): DeleteMutationJSON {
    const shape = this._shape.shape.id;
    const mode = this._mode || (this._ids ? 'ids' : undefined);
    if (mode === 'all') {
      return {v: WIRE_VERSION, op: 'delete', shape, mode: 'all'};
    }
    if (mode === 'where') {
      const wherePath = this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('DeleteBuilder.where() requires a condition callback.');
      }
      return {
        v: WIRE_VERSION,
        op: 'delete',
        shape,
        mode: 'where',
        where: serializeWherePath(wherePath),
      };
    }
    if (!this._ids || this._ids.length === 0) {
      throw new Error(
        'DeleteBuilder requires at least one ID, .all(), or .where() before .toJSON().',
      );
    }
    return {
      v: WIRE_VERSION,
      op: 'delete',
      shape,
      mode: 'ids',
      ids: this._ids.map((id) =>
        // An unresolved context ref travels as a `{$ctx}` marker; a concrete id
        // (string or `{id}`, incl. a resolved context shape) as a plain string.
        id instanceof PendingQueryContext
          ? encodeContextRef(id.contextName)
          : typeof id === 'string'
            ? id
            : id.id,
      ),
    };
  }

  /** Execute the mutation. */
  exec(): Promise<R> {
    const mode = this._mode || (this._ids ? 'ids' : undefined);
    if (mode === 'all' || mode === 'where') {
      return getQueryDispatch().deleteQuery(this).then(() => undefined) as Promise<R>;
    }
    return getQueryDispatch().deleteQuery(this) as Promise<R>;
  }

  // ---------------------------------------------------------------------------
  // Promise interface
  // ---------------------------------------------------------------------------

  then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<R | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<R> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'DeleteBuilder';
  }
}
