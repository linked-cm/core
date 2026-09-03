import type {SelectQuery} from './SelectQuery.js';
import type {CreateQuery} from './CreateQuery.js';
import type {UpdateQuery} from './UpdateQuery.js';
import type {DeleteQuery, DeleteResponse} from './DeleteQuery.js';
import type {IDataset} from '../interfaces/IDataset.js';
import type {AskQuery} from './AskQuery.js';

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
  /** Answer an ask query — a boolean, not a result set. */
  askQuery(query: AskQuery): Promise<boolean>;
  createQuery<R = any>(query: CreateQuery): Promise<R>;
  updateQuery<R = any>(query: UpdateQuery): Promise<R>;
  deleteQuery(query: DeleteQuery): Promise<DeleteResponse>;
}

/** A target that can answer an ask query. */
type ExistenceTarget = {askQuery(query: AskQuery): Promise<boolean>};

/**
 * Answer an ask query against `target` — the single entry point for every
 * boolean-answered query in the library. `AskBuilder.exec()` and
 * `LinkedStorage.askQuery` both come here rather than calling `askQuery`
 * directly, so the contract below is enforced once for every store.
 *
 * There is deliberately **no translation to a select query anywhere in this
 * package.** An ask goes to `IDataset.askQuery` and a SPARQL-backed store turns
 * it into `ASK`. A store that lacks a boolean primitive implements `askQuery`
 * itself, in whatever way its backend allows — that decision belongs to the
 * store, and making it here would hide it.
 *
 * `askQuery` must resolve to a real boolean: anything else rejects rather than
 * being coerced, since a truthy non-boolean would read as "exists". Errors
 * propagate for the same reason — "could not ask" is never `false`.
 */
export async function resolveExistence(
  target: ExistenceTarget,
  query: AskQuery,
): Promise<boolean> {
  if (typeof target?.askQuery !== 'function') {
    throw new Error(
      'This dataset does not implement the required IDataset.askQuery(query). ' +
      'An ask query is answered with a boolean — a SPARQL store emits ASK — and is ' +
      'never rewritten as a select on its behalf.',
    );
  }
  const answer = await target.askQuery(query);
  if (typeof answer !== 'boolean') {
    throw new Error(
      `askQuery must resolve to a boolean; got ${answer === null ? 'null' : typeof answer}. ` +
      'An ask query will not coerce a non-boolean into an answer — a truthy ' +
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
