import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {resolveShape} from './resolveShape.js';
import {type AddId, type UpdatePartial, NodeReferenceValue} from './QueryFactory.js';
import {UpdateQueryFactory, type UpdateQuery, type IRUpdateQuery} from './UpdateQuery.js';
import {getQueryDispatch} from './queryDispatch.js';
import {WIRE_VERSION} from './wireVersion.js';
import {PendingQueryContext, getQueryContext, UnresolvedContextError} from './QueryContext.js';
import type {NodeShape} from '../shapes/SHACL.js';
import {type WhereClause, type WherePath, processWhereClause} from './SelectQuery.js';
import {buildCanonicalUpdateWhereMutationIR} from './IRMutation.js';
import {toWhere} from './IRDesugar.js';
import {canonicalizeWhere} from './IRCanonicalize.js';
import {lowerWhereToIR} from './IRLower.js';
import type {ExpressionUpdateProxy, ExpressionUpdateResult} from '../expressions/ExpressionMethods.js';
import {encodeNodeData, decodeNodeDataToRaw, type UpdateMutationJSON} from './MutationSerialization.js';
import {serializeWherePath, deserializeWherePath} from './QueryBuilderSerialization.js';

type UpdateMode = 'for' | 'forAll' | 'where';

/**
 * Internal state bag for UpdateBuilder.
 */
interface UpdateBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  data?: UpdatePartial<S>;
  targetId?: string;
  mode?: UpdateMode;
  whereFn?: WhereClause<S>;
  /** A pre-resolved where path (used by fromJSON; no live callback). */
  where?: WherePath;
  /** A query-context name used as the target subject (resolved at lowering). */
  targetContextName?: string;
}

/**
 * An immutable, fluent builder for update mutations.
 *
 * Every mutation method returns a new UpdateBuilder — the original is never modified.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await UpdateBuilder.from(Person).for({id: '...'}).set({name: 'Bob'});
 * await UpdateBuilder.from(Person).set({hobby: 'x'}).forAll();  // returns void
 * ```
 *
 * R is the resolved type: AddId<U> for ID-based, void for bulk operations.
 */
export class UpdateBuilder<S extends Shape = Shape, U extends UpdatePartial<S> = UpdatePartial<S>, R = AddId<U>>
  implements PromiseLike<R>, Promise<R>
{
  private readonly _shape: ShapeConstructor<S>;
  private readonly _data?: UpdatePartial<S>;
  private readonly _targetId?: string;
  private readonly _mode?: UpdateMode;
  private readonly _whereFn?: WhereClause<S>;
  private readonly _where?: WherePath;
  private readonly _targetContextName?: string;

  private constructor(init: UpdateBuilderInit<S>) {
    this._shape = init.shape;
    this._data = init.data;
    this._targetId = init.targetId;
    this._mode = init.mode;
    this._whereFn = init.whereFn;
    this._where = init.where;
    this._targetContextName = init.targetContextName;
  }

  private clone(overrides: Partial<UpdateBuilderInit<S>> = {}): UpdateBuilder<S, any, any> {
    return new UpdateBuilder<S, any>({
      shape: this._shape,
      data: this._data,
      targetId: this._targetId,
      mode: this._mode,
      whereFn: this._whereFn,
      where: this._where,
      targetContextName: this._targetContextName,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  static from<S extends Shape>(shape: ShapeConstructor<S> | string): UpdateBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new UpdateBuilder<S>({shape: resolved});
  }

  /** Reconstruct an UpdateBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: UpdateMutationJSON): UpdateBuilder {
    const resolved = resolveShape(json.shape);
    const data = decodeNodeDataToRaw(json.data) as any;
    if (json.mode === 'for') {
      if (json.targetContext) {
        return new UpdateBuilder({shape: resolved, data, targetContextName: json.targetContext, mode: 'for'});
      }
      return new UpdateBuilder({shape: resolved, data, targetId: json.targetId, mode: 'for'});
    }
    if (json.mode === 'forAll') {
      return new UpdateBuilder({shape: resolved, data, mode: 'forAll'});
    }
    const where = deserializeWherePath(resolved.shape, json.where!);
    return new UpdateBuilder({shape: resolved, data, mode: 'where', where});
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Target a specific entity by ID. */
  for(id: string | NodeReferenceValue | PendingQueryContext): UpdateBuilder<S, U, AddId<U>> {
    if (id instanceof PendingQueryContext) {
      return this.clone({targetContextName: id.contextName, targetId: undefined, mode: 'for'}) as unknown as UpdateBuilder<S, U, AddId<U>>;
    }
    const resolvedId = typeof id === 'string' ? id : id.id;
    return this.clone({targetId: resolvedId, mode: 'for'}) as unknown as UpdateBuilder<S, U, AddId<U>>;
  }

  /** Update all instances of this shape type. Returns void. */
  forAll(): UpdateBuilder<S, U, void> {
    return this.clone({mode: 'forAll', targetId: undefined, whereFn: undefined}) as unknown as UpdateBuilder<S, U, void>;
  }

  /** Update instances matching a condition. Returns void. */
  where(fn: WhereClause<S>): UpdateBuilder<S, U, void> {
    return this.clone({mode: 'where', whereFn: fn, targetId: undefined}) as unknown as UpdateBuilder<S, U, void>;
  }

  /** Replace the update data. */
  set(fn: (p: ExpressionUpdateProxy<S>) => ExpressionUpdateResult<S>): UpdateBuilder<S, any, R>;
  set<NewU extends UpdatePartial<S>>(data: NewU): UpdateBuilder<S, NewU, R>;
  set(data: any): any {
    return this.clone({data}) as any;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'update' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShape {
    return this._shape.shape;
  }


  /** @internal Build the canonical IR. Consumed by `lower()`. */
  _toIR(): IRUpdateQuery {
    if (!this._data) {
      throw new Error(
        'UpdateBuilder requires .set(data) before it can be lowered. Specify what to update.',
      );
    }

    const mode = this._mode || (this._targetId ? 'for' : undefined);

    if (mode === 'forAll') {
      return this.buildUpdateWhere();
    }

    if (mode === 'where') {
      if (!this._whereFn && !this._where) {
        throw new Error(
          'UpdateBuilder.where() requires a condition callback.',
        );
      }
      return this.buildUpdateWhere();
    }

    // Default: ID-based update (target id may come from a query context)
    const targetId = this._resolveTargetId();
    if (!targetId) {
      if (this._targetContextName) {
        throw new UnresolvedContextError(this._targetContextName);
      }
      throw new Error(
        'UpdateBuilder requires .for(id), .forAll(), or .where() before it can be lowered.',
      );
    }
    const factory = new UpdateQueryFactory<S, UpdatePartial<S>>(
      this._shape,
      targetId,
      this._data,
    );
    return factory.build();
  }

  /** Resolve the target id from an explicit id or a query-context reference. */
  private _resolveTargetId(): string | undefined {
    if (this._targetId) return this._targetId;
    if (this._targetContextName) return getQueryContext(this._targetContextName)?.id;
    return undefined;
  }

  private buildUpdateWhere(): IRUpdateQuery {
    const factory = new UpdateQueryFactory<S, UpdatePartial<S>>(
      this._shape,
      '__placeholder__', // not used for where/forAll
      this._data!,
    );
    const description = factory.fields;

    let where;
    let wherePatterns;

    const wherePathSource = this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
    if (wherePathSource) {
      const wherePath = wherePathSource;
      const desugared = toWhere(wherePath);
      const canonical = canonicalizeWhere(desugared);
      const lowered = lowerWhereToIR(canonical);
      where = lowered.where;
      wherePatterns = lowered.wherePatterns;
    }

    return buildCanonicalUpdateWhereMutationIR({
      shape: this._shape.shape,
      updates: description,
      where,
      wherePatterns,
    });
  }

  /**
   * Serialize this update mutation to lightweight DSL-JSON. Evaluates the update
   * data through the factory (handles the expression-callback form of `.set()`),
   * and serializes the where clause for `where`-mode updates.
   */
  toJSON(): UpdateMutationJSON {
    if (!this._data) {
      throw new Error('UpdateBuilder requires .set(data) before .toJSON().');
    }
    const mode = this._mode || (this._targetId ? 'for' : undefined);
    if (!mode) {
      throw new Error(
        'UpdateBuilder requires .for(id), .forAll(), or .where() before .toJSON().',
      );
    }
    const factory = new UpdateQueryFactory<S, UpdatePartial<S>>(
      this._shape,
      this._targetId ?? '__placeholder__',
      this._data,
    );
    const json: UpdateMutationJSON = {
      v: WIRE_VERSION,
      op: 'update',
      shape: this._shape.shape.id,
      mode,
      data: encodeNodeData(factory.fields),
    };
    if (mode === 'for') {
      if (this._targetContextName) json.targetContext = this._targetContextName;
      else json.targetId = this._targetId;
    }
    if (mode === 'where') {
      const wherePath = this._where ?? (this._whereFn ? processWhereClause(this._whereFn, this._shape) : undefined);
      if (!wherePath) {
        throw new Error('UpdateBuilder.where() requires a condition callback.');
      }
      json.where = serializeWherePath(wherePath);
    }
    return json;
  }

  /** Execute the mutation. */
  exec(): Promise<R> {
    const mode = this._mode || (this._targetId ? 'for' : undefined);
    if (mode === 'forAll' || mode === 'where') {
      return getQueryDispatch().updateQuery(this).then(() => undefined) as Promise<R>;
    }
    return getQueryDispatch().updateQuery(this) as Promise<R>;
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
    return 'UpdateBuilder';
  }
}
