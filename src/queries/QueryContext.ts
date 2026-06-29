import {type QShape, QueryShape} from './SelectQuery.js';
import {Shape} from '../shapes/Shape.js';

const queryContext = new Map<string, QShape<any, any, any>>();

/**
 * A live reference returned by getQueryContext when the context hasn't been set yet.
 * Its `id` getter resolves lazily from the global context map, so queries built with
 * a PendingQueryContext will pick up the value once it's set (e.g. after auth completes).
 */
export class PendingQueryContext {
  constructor(public readonly contextName: string) {}

  get id(): string | undefined {
    return queryContext.get(this.contextName)?.id;
  }
}

/**
 * Thrown when a query carrying a context reference is lowered but the context
 * isn't set in the current process. A context ref is carried in DSL-JSON and
 * resolves at lowering time against whatever context map is available (e.g.
 * server-side auth); if it can't resolve, lowering throws this rather than
 * silently producing a subject-less query.
 */
export class UnresolvedContextError extends Error {
  constructor(public readonly contextName: string) {
    super(
      `Query context "${contextName}" is not set and could not be resolved at lowering time.`,
    );
    this.name = 'UnresolvedContextError';
  }
}

/** Listener notified (with the changed context name) whenever a context is set or cleared. */
export type QueryContextListener = (name: string) => void;
const contextListeners = new Set<QueryContextListener>();

/**
 * Subscribe to query-context changes. Returns an unsubscribe function.
 *
 * This is the primitive that makes context resolution reactive: a consuming layer
 * (e.g. React components) subscribes and re-runs affected queries when the context
 * lands — so a query that resolved to `null` while the context was unset simply
 * re-runs and resolves once it's available ("waiting"), and re-runs again on any
 * later change ("auto re-resolve"). Core only emits the change; re-execution is the
 * consumer's responsibility.
 */
export function subscribeQueryContext(listener: QueryContextListener): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

function notifyContextChange(name: string): void {
  // Snapshot so a listener that (un)subscribes or re-sets a context during
  // notification can't mutate the set mid-iteration.
  for (const listener of [...contextListeners]) listener(name);
}

export function getQueryContext<T extends Shape>(name: string): QShape<T> {
  if (queryContext.has(name)) {
    return queryContext.get(name);
  }
  // Return a live reference that resolves lazily when the context is set.
  // This avoids the timing issue where module-level queries capture null
  // because the context hasn't been set yet (e.g. useEffect hasn't fired).
  return new PendingQueryContext(name) as any;
}

export function setQueryContext(name: string, value: any, shapeType?) {
  // Clearing a context entry
  if (!value) {
    queryContext.delete(name);
    notifyContextChange(name);
    return;
  }

  //if a QResult was provided
  if (typeof value.id === 'string') {
    //convert to QShape
    if (!shapeType) {
      console.warn(
        'setQueryContext: value is a QResult but no shapeType provided',
        value,
      );
      return;
    }
    const shape = new (shapeType as any)();
    shape.id = value.id;
    shape.__queryContextId = value.id;
    shape.__queryContextName = name;
    value = QueryShape.create(shape);
  }
  if (value instanceof Shape) {
    value.__queryContextName = name;
    //convert to QShape
    value = new QueryShape(value);
  } else if (!(value instanceof QueryShape)) {
    console.warn('setQueryContext: value is not a QueryShape or Shape', value);
    return;
  }

  queryContext.set(name, value);
  notifyContextChange(name);
}
