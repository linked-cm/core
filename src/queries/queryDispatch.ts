import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {IDataset} from '../interfaces/IDataset.js';

/**
 * Abstraction boundary between the DSL layer (Shape) and the storage layer
 * (LinkedStorage / IDataset). Both sides import this leaf module; neither
 * imports the other.
 *
 * Return types are intentionally `any` — the DSL layer threads precise
 * result types through its own generics; the dispatch is a runtime bridge.
 */
export interface QueryDispatch {
  selectQuery<R = any>(query: SelectQuery): Promise<R>;
  /** Whether any solution exists — a boolean, not a result set. */
  askQuery(query: SelectQuery): Promise<boolean>;
  createQuery<R = any>(query: CreateQuery): Promise<R>;
  updateQuery<R = any>(query: UpdateQuery): Promise<R>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
}

/** The minimum a target needs to answer an existence check the slow way. */
type SelectCapable = {selectQuery(query: SelectQuery): Promise<any>};

/** A target that can answer an existence check. */
type ExistenceTarget = SelectCapable & {
  askQuery?(query: SelectQuery): Promise<boolean>;
};

/**
 * Rejects a query whose pagination would make the two existence paths disagree.
 *
 * `ASK` has no pagination, so `askToAlgebra` refuses `OFFSET` and `LIMIT < 1`
 * rather than dropping them. The SELECT degradation *would* honour both — and
 * would then answer a different question than the store that can do `ASK`. The
 * same guard therefore runs in front of both paths, so which store you are
 * pointed at can never change the answer.
 *
 * `.exists()` normalises pagination away before dispatching, so this only fires
 * for a direct `LinkedStorage.askQuery` / `IDataset.askQuery` caller.
 */
function assertAnswerableWithoutPagination(query: SelectQuery): void {
  const raw = query?.toRawInput?.();
  if (!raw) return;
  if (raw.offset !== undefined) {
    throw new Error(
      'An existence check cannot honour OFFSET: it skips solutions, so the answer ' +
      'would depend on the page rather than on whether a match exists. Drop the ' +
      'offset before asking.',
    );
  }
  if (raw.limit !== undefined && raw.limit < 1) {
    throw new Error(
      `An existence check cannot honour LIMIT ${raw.limit}: it returns no rows where ` +
      'the same pattern does have a match. Drop the limit before asking.',
    );
  }
}

/**
 * The shared default implementation of {@link IDataset.askQuery}, for a backend
 * with no boolean primitive of its own:
 *
 * ```ts
 * askQuery(query: SelectQuery) {
 *   return askViaSelect(this, query);
 * }
 * ```
 *
 * Runs the already-normalised query as `SELECT … LIMIT 1` and converts. A slower
 * answer, never a different one — it is exactly what `.exists()` shipped on.
 * Failures propagate; an unreachable store rejects rather than answering `false`.
 *
 * Exported so that every store taking this route shares one implementation
 * instead of writing its own conversion.
 */
export async function askViaSelect(
  target: SelectCapable,
  query: SelectQuery,
): Promise<boolean> {
  const result = await target.selectQuery(query);
  return Array.isArray(result) ? result.length > 0 : result != null;
}

/**
 * Answer "does any solution exist?" against `target` — the single entry point for
 * every existence check in the library. `SelectBuilder.exists()` and
 * `LinkedStorage.askQuery` both come here rather than calling `askQuery`
 * directly, so the contract below is enforced once for every store.
 *
 * The caller must have normalised the query first (drop the projection, preloads,
 * sorting and pagination; `LIMIT 1`) — `.exists()` does.
 *
 * `askQuery` is **required** on `IDataset`; a target without it is a store that
 * has not implemented the interface, which is reported as such rather than
 * quietly worked around. (TypeScript catches this at compile time; the runtime
 * check is for JavaScript consumers.) It must resolve to a real boolean —
 * anything else rejects rather than being coerced, since a truthy non-boolean
 * would read as "exists". Errors propagate for the same reason: "could not ask"
 * is never `false`.
 */
export async function resolveExistence(
  target: ExistenceTarget,
  query: SelectQuery,
): Promise<boolean> {
  assertAnswerableWithoutPagination(query);
  if (typeof target.askQuery !== 'function') {
    throw new Error(
      'This dataset does not implement the required IDataset.askQuery(query). ' +
      'Implement it using the backend\'s boolean primitive (a SPARQL store answers ' +
      'ASK), or delegate to the shared default: ' +
      '`askQuery(query) { return askViaSelect(this, query); }`.',
    );
  }
  const answer = await target.askQuery(query);
  if (typeof answer !== 'boolean') {
    throw new Error(
      `askQuery must resolve to a boolean; got ${answer === null ? 'null' : typeof answer}. ` +
      'An existence check will not coerce a non-boolean into an answer — a truthy ' +
      'value would silently read as "exists".',
    );
  }
  return answer;
}

// Global-backed so it is SHARED across duplicate copies of this module. In dev,
// `@_linked/core` can be evaluated twice (Vite/`src` + Node/`lib` — an accepted
// 2-instance state, see report-011). The module REGISTRY already lives on the
// shared global; the query dispatch must too, or `setDefaultDataset()` on one
// copy is invisible to queries on the other ("No query dispatch configured").
// Whichever copy runs the storage config sets it; every copy reads it.
const dispatchGlobal: any =
  typeof globalThis !== 'undefined' ? globalThis : ({} as any);
if (!('__linkedQueryDispatch' in dispatchGlobal)) {
  dispatchGlobal.__linkedQueryDispatch = {current: null as QueryDispatch | null};
}

export function setQueryDispatch(d: QueryDispatch): void {
  dispatchGlobal.__linkedQueryDispatch.current = d;
}

export function getQueryDispatch(): QueryDispatch {
  const dispatch = dispatchGlobal.__linkedQueryDispatch.current as QueryDispatch | null;
  if (!dispatch) {
    throw new Error(
      'No query dispatch configured. Call LinkedStorage.setDefaultDataset() first.',
    );
  }
  return dispatch;
}

/** The mutating query kinds — the `IDataset` methods that are optional per-store. */
export type MutationKind = 'create' | 'update' | 'delete';

/**
 * Pick the object a mutation `exec(target?)` dispatches through: the explicit `target`
 * dataset (validated to implement the op) when a target is given, otherwise the global
 * dispatch. Unlike `selectQuery`, a store's mutation methods are optional on `IDataset`,
 * so a target that can't perform `kind` is a caller error.
 *
 * Throws synchronously if the target lacks the method — callers invoke this from within an
 * `async exec`, so the throw surfaces as a rejected promise rather than a synchronous throw.
 */
export function resolveMutationDispatch(
  kind: MutationKind,
  target?: IDataset,
): QueryDispatch {
  if (!target) return getQueryDispatch();
  if (typeof target[`${kind}Query`] !== 'function') {
    throw new Error(`The target dataset does not support ${kind} queries.`);
  }
  return target as unknown as QueryDispatch;
}
