import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {resolveShape} from './resolveShape.js';
import type {UpdatePartial} from './QueryFactory.js';
import {CreateQueryFactory, type CreateQuery, type IRCreateQuery, type CreateResponse} from './CreateQuery.js';
import {getQueryDispatch} from './queryDispatch.js';
import {WIRE_VERSION} from './wireVersion.js';
import type {NodeShape} from '../shapes/SHACL.js';
import {encodeNodeData, decodeNodeDataToRaw, type CreateMutationJSON} from './MutationSerialization.js';

/**
 * Internal state bag for CreateBuilder.
 */
interface CreateBuilderInit<S extends Shape> {
  shape: ShapeConstructor<S>;
  data?: UpdatePartial<S>;
  fixedId?: string;
}

/**
 * An immutable, fluent builder for create mutations.
 *
 * Every mutation method returns a new CreateBuilder — the original is never modified.
 *
 * Implements PromiseLike so mutations execute on `await`:
 * ```ts
 * const result = await CreateBuilder.from(Person).set({name: 'Alice'});
 * ```
 *
 * Internally delegates to CreateQueryFactory for IR generation.
 */
export class CreateBuilder<S extends Shape = Shape, U extends UpdatePartial<S> = UpdatePartial<S>>
  implements PromiseLike<CreateResponse<U>>, Promise<CreateResponse<U>>
{
  private readonly _shape: ShapeConstructor<S>;
  private readonly _data?: UpdatePartial<S>;
  private readonly _fixedId?: string;

  private constructor(init: CreateBuilderInit<S>) {
    this._shape = init.shape;
    this._data = init.data;
    this._fixedId = init.fixedId;
  }

  private clone(overrides: Partial<CreateBuilderInit<S>> = {}): CreateBuilder<S, any> {
    return new CreateBuilder<S, any>({
      shape: this._shape,
      data: this._data,
      fixedId: this._fixedId,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Static constructors
  // ---------------------------------------------------------------------------

  /**
   * Create a CreateBuilder for the given shape.
   */
  static from<S extends Shape>(shape: ShapeConstructor<S> | string): CreateBuilder<S> {
    const resolved = resolveShape<S>(shape);
    return new CreateBuilder<S>({shape: resolved});
  }

  /** Reconstruct a CreateBuilder from its DSL-JSON (inverse of `toJSON`). */
  static fromJSON(json: CreateMutationJSON): CreateBuilder {
    return CreateBuilder.from(json.shape).set(decodeNodeDataToRaw(json.data) as any);
  }

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  /** Set the data for the entity to create. */
  set<NewU extends UpdatePartial<S>>(data: NewU): CreateBuilder<S, NewU> {
    return this.clone({data}) as unknown as CreateBuilder<S, NewU>;
  }

  /** Pre-assign a node ID for the created entity. */
  withId(id: string): CreateBuilder<S, U> {
    return this.clone({fixedId: id}) as unknown as CreateBuilder<S, U>;
  }

  // ---------------------------------------------------------------------------
  // Build & execute
  // ---------------------------------------------------------------------------

  /** Discriminator for the free `lower()` function and dataset routing. */
  readonly __queryKind = 'create' as const;

  /** The shape this query targets — the routing key datasets/`LinkedStorage` use. */
  get shape(): NodeShape {
    return this._shape.shape;
  }


  /** @internal Build the canonical IR. Consumed by `lower()`. Throws if no data was set. */
  _toIR(): IRCreateQuery {
    if (!this._data) {
      throw new Error(
        'CreateBuilder requires .set(data) before it can be lowered. Specify what to create.',
      );
    }
    const data = this._data;

    // Validate that required properties (minCount >= 1) are present in data
    const shapeObj = this._shape.shape;
    if (shapeObj) {
      const requiredProps = shapeObj
        .getUniquePropertyShapes()
        .filter((ps) => ps.minCount && ps.minCount >= 1);
      const dataKeys = new Set(Object.keys(data));
      const missing = requiredProps
        .filter((ps) => !dataKeys.has(ps.label))
        .map((ps) => ps.label);
      if (missing.length > 0) {
        throw new Error(
          `Missing required fields for '${shapeObj.label || shapeObj.id}': ${missing.join(', ')}`,
        );
      }
    }
    // TODO: Full data validation against the shape (type checking, maxCount, nested shapes, etc.)

    // Inject __id if fixedId is set
    const dataWithId = this._fixedId
      ? {...(data as any), __id: this._fixedId}
      : data;
    const factory = new CreateQueryFactory<S, UpdatePartial<S>>(
      this._shape,
      dataWithId as UpdatePartial<S>,
    );
    return factory.build();
  }

  /**
   * Serialize this create mutation to lightweight DSL-JSON. Evaluates the create
   * data through the factory (the same conversion `lower()` runs) so the result is
   * concrete and JSON-safe, then encodes the normalized node description.
   */
  toJSON(): CreateMutationJSON {
    if (!this._data) {
      throw new Error('CreateBuilder requires .set(data) before .toJSON().');
    }
    const dataWithId = this._fixedId
      ? {...(this._data as any), __id: this._fixedId}
      : this._data;
    const factory = new CreateQueryFactory<S, UpdatePartial<S>>(
      this._shape,
      dataWithId as UpdatePartial<S>,
    );
    return {
      v: WIRE_VERSION,
      op: 'create',
      shape: this._shape.shape.id,
      data: encodeNodeData(factory.description),
    };
  }

  /** Execute the mutation. */
  exec(): Promise<CreateResponse<U>> {
    return getQueryDispatch().createQuery(this) as Promise<CreateResponse<U>>;
  }

  // ---------------------------------------------------------------------------
  // Promise interface
  // ---------------------------------------------------------------------------

  then<TResult1 = CreateResponse<U>, TResult2 = never>(
    onfulfilled?: ((value: CreateResponse<U>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<CreateResponse<U> | TResult> {
    return this.then().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<CreateResponse<U>> {
    return this.then().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'CreateBuilder';
  }
}
