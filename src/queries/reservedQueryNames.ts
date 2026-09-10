/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The names the query proxies answer themselves.
 *
 * `QueryShape`/`QueryShapeSet` resolve a key against their own surface (`key in
 * queryShape`) before they look for a property shape with that label, so a property
 * named after one of these is unreachable through the builder: the caller gets the DSL
 * method, and the field tracer then fails on a native function. Registration warns about
 * such a label (see `warnOnReservedPropertyLabel`).
 *
 * Deliberately a literal, not derived from the classes: the shape registry must not
 * import the query builder (that edge would close an import cycle through `SHACL.ts`).
 * `dsl-property-name-collisions.test.ts` compares this list against the live prototypes,
 * so a DSL method added later cannot drift out of it unnoticed.
 */
export const RESERVED_QUERY_DSL_NAMES: ReadonlySet<string> = new Set([
  // prototype surface of QueryShape / QueryShapeSet (and their base)
  'add',
  'as',
  'buildPredicateExpression',
  'callPropertyShapeAccessor',
  'concat',
  'constructor',
  'equals',
  'every',
  'getOriginalValue',
  'getPropertyPath',
  'getPropertyStep',
  'id',
  'limit',
  'none',
  'notOneOf',
  'oneOf',
  'preloadFor',
  'select',
  'selectAll',
  'size',
  'some',
  'where',
  // instance fields — `in` sees these as well
  'originalValue',
  'prop',
  'property',
  'proxy',
  'queryShapes',
  'source',
  'subject',
  'wherePath',
]);

export function isReservedQueryDslName(label: string | undefined): boolean {
  return !!label && RESERVED_QUERY_DSL_NAMES.has(label);
}

/** One warning per shape + label; a shape re-registered on hot reload must not spam. */
const reported = new Set<string>();

/**
 * Tell the model author about a colliding label while they can still rename it.
 *
 * A warning rather than a throw, on purpose. `size`, `id` and `some` are legitimate
 * names for a domain property, and the property still works everywhere except the
 * proxy-traced builder — DSL-JSON reaches it by path, and the data round-trips
 * unharmed. Throwing here would break existing apps on upgrade over a property they may
 * never select through the builder. (Contrast `RESERVED_PROPERTY_LABELS` in `SHACL.ts`,
 * which does throw: a DSL-JSON combinator name has no escape hatch at all.)
 */
export function warnOnReservedPropertyLabel(
  label: string | undefined,
  shapeLabel: string | undefined,
  shapeId?: string,
): void {
  if (!isReservedQueryDslName(label)) return;
  const key = `${shapeId ?? shapeLabel ?? ''}#${label}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[linked] ${shapeLabel ?? shapeId ?? 'shape'}.${label} shadows the query DSL: ` +
      `'${label}' is a method of the query builder, so \`select(s => s.${label})\` returns ` +
      `that method instead of the property and the query fails while tracing fields. ` +
      `Rename the property (the RDF predicate can stay the same) to make it selectable.`,
  );
}

/** Test seam: forget which collisions were already reported. */
export function resetReservedPropertyLabelWarnings(): void {
  reported.clear();
}
