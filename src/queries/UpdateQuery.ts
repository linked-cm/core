import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {
  type AddId,
  type NodeDescriptionValue,
  NodeReferenceValue,
  type UpdatePartial,
  toNodeReference,
} from './QueryFactory.js';
import {MutationQueryFactory} from './MutationQuery.js';
import type {IRUpdateMutation, IRUpdateWhereMutation} from './IntermediateRepresentation.js';
import {buildCanonicalUpdateMutationIR} from './IRMutation.js';
import type {NodeShape} from '../shapes/SHACL.js';
import type {UpdateMutationJSON} from './MutationSerialization.js';

/**
 * The closed, read-only update query a dataset receives (implemented by
 * `UpdateBuilder`). The IR is `IRUpdateQuery`, produced by `lower(query)`.
 */
export interface UpdateQuery {
  readonly __queryKind: 'update';
  readonly shape: NodeShape;
  toJSON(): UpdateMutationJSON;
  _toIR(): IRUpdateQuery;
}

/** The lowered IR for an update mutation (what `lower()` produces). */
export type IRUpdateQuery = IRUpdateMutation | IRUpdateWhereMutation;

export class UpdateQueryFactory<
  ShapeType extends Shape,
  U extends UpdatePartial<ShapeType>,
> extends MutationQueryFactory {
  readonly id: string;
  readonly fields: NodeDescriptionValue;

  constructor(
    public shapeClass: ShapeConstructor<ShapeType>,
    id: string | NodeReferenceValue,
    updateObjectOrFn: U,
  ) {
    super();
    this.id = toNodeReference(id).id;
    this.fields = this.convertUpdateObject(
      updateObjectOrFn,
      this.shapeClass.shape,
    );
  }

  build(): IRUpdateQuery {
    return buildCanonicalUpdateMutationIR({
      id: this.id,
      shape: this.shapeClass.shape,
      updates: this.fields,
    });
  }
}
