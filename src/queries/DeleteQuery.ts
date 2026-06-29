import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {NodeReferenceValue, type UpdatePartial} from './QueryFactory.js';
import {MutationQueryFactory, type NodeId} from './MutationQuery.js';
import type {
  IRDeleteMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
} from './IntermediateRepresentation.js';
import {buildCanonicalDeleteMutationIR} from './IRMutation.js';
import type {NodeShape} from '../shapes/SHACL.js';
import type {DeleteMutationJSON} from './MutationSerialization.js';

/**
 * The closed, read-only delete query a dataset receives (implemented by
 * `DeleteBuilder`). The IR is `IRDeleteQuery`, produced by `lower(query)`.
 */
export interface DeleteQuery {
  readonly __queryKind: 'delete';
  readonly shape: NodeShape;
  toJSON(): DeleteMutationJSON;
  _toIR(): IRDeleteQuery;
}

/** The lowered IR for a delete mutation (what `lower()` produces). */
export type IRDeleteQuery = IRDeleteMutation | IRDeleteAllMutation | IRDeleteWhereMutation;

export type DeleteResponse = {
  /**
   * The IDs of the items that were successfully deleted.
   */
  deleted: NodeReferenceValue[];
  /**
   * The number of successfully deleted items.
   */
  count: number;
  /**
   * The IDs of the items that couldn't be deleted.
   */
  failed?: NodeReferenceValue[];
  /**
   * A mapping of IDs to error messages for the items that couldn't be deleted.
   */
  errors?: Record<string, string>;
};

export class DeleteQueryFactory<
  ShapeType extends Shape,
  U extends UpdatePartial<ShapeType>,
> extends MutationQueryFactory {
  readonly id: string;
  readonly ids: NodeReferenceValue[];

  constructor(
    public shapeClass: ShapeConstructor<ShapeType>,
    ids: NodeId[] | NodeId,
  ) {
    super();
    this.ids = this.convertNodeReferences(ids);
  }

  build(): IRDeleteQuery {
    return buildCanonicalDeleteMutationIR({
      shape: this.shapeClass.shape,
      ids: this.ids,
    });
  }
}
