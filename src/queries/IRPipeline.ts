import {desugarSelectQuery, type RawSelectInput} from './IRDesugar.js';
import {canonicalizeDesugaredSelectQuery} from './IRCanonicalize.js';
import {lowerSelectQuery} from './IRLower.js';
import type {IRSelectQuery} from './IntermediateRepresentation.js';

const isIRSelectQuery = (query: unknown): query is IRSelectQuery =>
  !!query &&
  typeof query === 'object' &&
  'kind' in query &&
  (query as IRSelectQuery).kind === 'select';

type BuildSelectQuery = (query: RawSelectInput | IRSelectQuery) => IRSelectQuery;

/** The unhooked pipeline entry point — tests wrap this to observe input. */
export const buildSelectQueryImpl: BuildSelectQuery = (query) => {
  if (isIRSelectQuery(query)) {
    return query;
  }

  const desugared = desugarSelectQuery(query as RawSelectInput);
  const canonical = canonicalizeDesugaredSelectQuery(desugared);
  return lowerSelectQuery(canonical);
};

// Indirection so the build step can be intercepted under ESM (where the module
// namespace is frozen and `jest.spyOn` can't reassign the export). Tests swap the
// hook via `setBuildSelectQueryHook`; production always uses `buildSelectQueryImpl`.
let buildSelectQueryHook: BuildSelectQuery = buildSelectQueryImpl;

/**
 * Runs the full select pipeline: desugar → canonicalize → lower.
 * Accepts either a RawSelectInput (from a query factory) or an already-built
 * IRSelectQuery (returned as-is).
 */
export const buildSelectQuery: BuildSelectQuery = (query) =>
  buildSelectQueryHook(query);

/** Test-only seam: override the pipeline entry point. Returns a restore fn. */
export const setBuildSelectQueryHook = (fn: BuildSelectQuery): (() => void) => {
  const previous = buildSelectQueryHook;
  buildSelectQueryHook = fn;
  return () => {
    buildSelectQueryHook = previous;
  };
};
