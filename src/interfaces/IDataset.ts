import type {SelectQuery} from '../queries/SelectQuery.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from '../queries/DeleteQuery.js';
import type {
  SelectResult,
  CreateResult,
  UpdateResult,
} from '../queries/IntermediateRepresentation.js';

/**
 * Universal dataset interface. Every dataset in the Linked framework accepts
 * Linked Queries as input. The implementing class decides how to handle them —
 * compiling to SPARQL for Fuseki, forwarding as-is to a Host Agent API, etc.
 *
 * Each method receives the live, closed (read-only) query object — the builder
 * viewed through its `*Query` interface — and returns the result. A store reads
 * `query.toJSON()` to forward it, or `lower(query)` to get canonical IR. The
 * calling layer (LinkedStorage via queryDispatch) threads the precise DSL-level
 * TypeScript result type back to the caller.
 */
export interface IDataset {
  /**
   * Prepares the store to be used.
   */
  init?(): Promise<any>;

  selectQuery(query: SelectQuery): Promise<SelectResult>;
  /**
   * Whether any solution exists for `query` — a boolean, not a result set.
   *
   * Optional. A store that does not implement it is not left guessing: the
   * existence check degrades through the single shared `askViaSelect` helper to
   * `selectQuery` on the same (already normalised) query, which is the form
   * `.exists()` shipped on. Implement it when the backend has a cheaper boolean
   * primitive — a SPARQL store answers `ASK WHERE { … }`.
   *
   * Must reject on failure. Reporting an unreachable store as `false` is the
   * failure mode `.exists()` was built to remove.
   */
  askQuery?(query: SelectQuery): Promise<boolean>;
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}
