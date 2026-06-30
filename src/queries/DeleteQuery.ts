import type {NodeReferenceValue} from './QueryFactory.js';
import type {
  IRDeleteMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
} from './IntermediateRepresentation.js';
import type {NodeShape} from '../shapes/SHACL.js';
import type {DeleteMutationJSON} from './MutationSerialization.js';
import type {DeleteLowerSpec} from './mutationLowerSpec.js';

/**
 * The closed, read-only delete query a dataset receives (implemented by
 * `DeleteBuilder`). The IR is `IRDeleteQuery`, produced by `lower(query)` — the
 * IR construction lives in the IR tier, not here, so this module stays IR-free.
 */
export interface DeleteQuery {
  readonly __queryKind: 'delete';
  readonly shape: NodeShape;
  toJSON(): DeleteMutationJSON;
  /** @internal IR-free lowering spec consumed by `lower()`. */
  _lowerSpec(): DeleteLowerSpec;
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
