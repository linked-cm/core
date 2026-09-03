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
   * **Required.** The query is an ordinary `SelectQuery`, already normalised to
   * its cheapest correct form (no projection, no preloads, no sorting, no
   * pagination, `LIMIT 1`); only the answer differs. A backend with a boolean
   * primitive should use it — a SPARQL store answers `ASK WHERE { … }`.
   *
   * A backend without one delegates to the shared default in a single line, and
   * says so by writing it:
   *
   * ```ts
   * askQuery(query: SelectQuery) {
   *   return askViaSelect(this, query);
   * }
   * ```
   *
   * It is required rather than optional so that the choice is visible in every
   * store. An optional method would let a store silently take the slower path
   * with nothing at the call site or in the types to say so.
   *
   * Must resolve to a real boolean — a non-boolean is rejected, not coerced,
   * since a truthy value would silently read as "exists". Must reject on
   * failure: reporting an unreachable store as `false` is the failure mode
   * `.exists()` was built to remove.
   */
  askQuery(query: SelectQuery): Promise<boolean>;
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}
