import type {SelectQuery} from '../queries/SelectQuery.js';
import type {AskQuery} from '../queries/AskQuery.js';
import type {CountQuery} from '../queries/CountQuery.js';
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
   * Answer an ask query — a boolean, not a result set.
   *
   * **Required.** An {@link AskQuery} carries a pattern and nothing else: no
   * projection, no sorting, no pagination. A SPARQL-backed store emits
   * `ASK WHERE { … }`; another backend answers it however it can.
   *
   * It is required rather than optional, and this package contains **no path that
   * rewrites an ask as a select**. A store that has no boolean primitive decides
   * for itself how to answer — that decision belongs to the store, and defaulting
   * it here would hide it.
   *
   * `query.shape` is optional: absent means no `rdf:type` constraint at all
   * ("does a node with this IRI exist"), which lowers to `ASK { <iri> ?p ?o }`.
   *
   * Must resolve to a real boolean — a non-boolean is rejected, not coerced,
   * since a truthy value would silently read as "exists". Must reject on
   * failure: reporting an unreachable store as `false` is the failure mode this
   * API was built to remove.
   */
  askQuery(query: AskQuery): Promise<boolean>;
  /**
   * Count the matching instances — a number, not a result set.
   *
   * **Optional**, unlike {@link askQuery}. Adding a required method would break
   * every existing implementer at compile time; `resolveCount` in `queryDispatch`
   * turns a missing implementation into a precise runtime error instead. Every
   * store extending {@link SparqlDataset} gets it with no edit.
   *
   * A {@link CountQuery} carries a pattern and nothing else: no projection, no
   * sorting, and in particular no pagination — a count of a windowed query is
   * meaningless, so the type cannot hold a window. A SPARQL-backed store emits
   * `SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { … }`; another backend answers it
   * however it can. This package contains **no path that rewrites a count as a
   * select** and measures the array: that would hide an unbounded read behind a
   * call that looks cheap.
   *
   * Must resolve to a real, non-negative integer — a non-number is rejected, not
   * coerced. Must reject on failure: reporting an unreachable store as `0` renders
   * an empty table that is indistinguishable from real data, which is the failure
   * mode this API was built to remove.
   */
  countQuery?(query: CountQuery): Promise<number>;
  /**
   * Receives update AND upsert mutations — `lower(query)` yields `kind: 'update'`,
   * `'update_where'` or `'upsert'`. An implementation that does not handle `'upsert'`
   * should throw rather than fall through to the update path: an upsert lowered as a
   * plain update writes an untyped node and reports success.
   */
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}
