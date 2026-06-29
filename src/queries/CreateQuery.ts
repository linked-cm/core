import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import type {AddId, NodeDescriptionValue, UpdatePartial} from './QueryFactory.js';
import {MutationQueryFactory} from './MutationQuery.js';
import type {IRCreateMutation} from './IntermediateRepresentation.js';
import {buildCanonicalCreateMutationIR} from './IRMutation.js';
import type {NodeShape} from '../shapes/SHACL.js';
import type {CreateMutationJSON} from './MutationSerialization.js';

/**
 * The canonical CreateQuery type — an IR AST node representing a create mutation.
 * This is the type received by IDataset.createQuery().
 */
/**
 * The closed, read-only create query a dataset receives (implemented by
 * `CreateBuilder`). The IR is `IRCreateQuery`, produced by `lower(query)`.
 */
export interface CreateQuery {
  readonly __queryKind: 'create';
  readonly shape: NodeShape;
  toJSON(): CreateMutationJSON;
  _toIR(): IRCreateQuery;
}

/** The lowered IR for a create mutation (what `lower()` produces). */
export type IRCreateQuery = IRCreateMutation;

export type CreateResponse<U> = AddId<U, true>;

export class CreateQueryFactory<
  ShapeType extends Shape,
  U extends UpdatePartial<ShapeType>,
> extends MutationQueryFactory {
  readonly id: string;
  readonly description: NodeDescriptionValue;

  constructor(
    public shapeClass: ShapeConstructor<ShapeType>,
    updateObjectOrFn: U,
  ) {
    super();
    this.description = this.convertUpdateObject(
      updateObjectOrFn,
      this.shapeClass.shape,
      true,
    );
  }

  build(): IRCreateQuery {
    return buildCanonicalCreateMutationIR({
      shape: this.shapeClass.shape,
      description: this.description,
    });
  }
}
