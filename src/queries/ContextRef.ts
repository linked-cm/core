/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The unified wire encoding for a *query-context reference*.
 *
 * A context reference is a placeholder for a node id that is not known when the
 * query is authored — e.g. "the currently authenticated user". Instead of
 * resolving it eagerly (which loses the reference and breaks queries built
 * before auth completes), the reference is carried on the wire as a tagged
 * marker and resolved at lowering time against whatever context map is
 * available (client-side React context, server-side auth, …).
 *
 * The same `{@ctx: "<name>"}` marker is used in *every* position a node id can
 * appear: the select subject, the update target, where-clause arguments, and
 * mutation field values. One marker, one resolver, everywhere.
 */
import {getQueryContext, UnresolvedContextError} from './QueryContext.js';

/**
 * DSL-JSON system value-tags. These `@`-prefixed keys are the reserved
 * vocabulary for tagged *values* (dates, node refs, lists, set-mods, unset,
 * computed paths, context refs). The `@` sigil frees every user property name —
 * a property literally named `date`/`id`/`path`/… no longer collides with a tag.
 * (Structural node-data keys stay `__id`/`__shape`.)
 */
export const WIRE_TAG = {
  id: '@id',
  date: '@date',
  list: '@list',
  add: '@add',
  remove: '@remove',
  unset: '@unset',
  path: '@path',
  ctx: '@ctx',
} as const;

/** The reserved key that tags a context reference in DSL-JSON. */
export const CONTEXT_REF_KEY = WIRE_TAG.ctx;

/** The wire shape of a context reference: `{@ctx: "<contextName>"}`. */
export interface ContextRefJSON {
  [CONTEXT_REF_KEY]: string;
}

/** Build a context-reference marker for the given context name. */
export function encodeContextRef(name: string): ContextRefJSON {
  return {[CONTEXT_REF_KEY]: name};
}

/** Type guard: is this value a `{@ctx: "..."}` context-reference marker? */
export function isContextRefJSON(value: unknown): value is ContextRefJSON {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)[CONTEXT_REF_KEY] === 'string' &&
    Object.keys(value as object).length === 1
  );
}

/**
 * Resolve a context name to its node id against the current context map.
 *
 * @param name     the context name (e.g. `'user'`)
 * @param required when true, throw {@link UnresolvedContextError} if the context
 *   isn't set (the mutation contract — a mutation must not silently target
 *   nothing). When false, return `undefined` (the select contract — an
 *   unresolved subject simply yields no results, and a reactive layer re-runs
 *   the query once the context lands).
 */
export function resolveContextId(
  name: string,
  required: boolean,
): string | undefined {
  const id = getQueryContext(name)?.id;
  if (!id && required) {
    throw new UnresolvedContextError(name);
  }
  return id;
}
