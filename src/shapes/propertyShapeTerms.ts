/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import '../utils/Package.js'; // side effect: sets up the meta-model this table reads
import {isPathRef} from '../paths/PropertyPathExpr.js';
import {PropertyShape} from './SHACL.js';

/**
 * How ONE SHACL constraint of a `sh:PropertyShape` is written to RDF: which predicate
 * it uses and (when the meta-model pins one) which literal datatype / node kind.
 */
export interface PropertyShapeTerm {
  /**
   * The constraint's name as used by the decorator config and by `PropertyShapeData`
   * — e.g. `pattern`, `minLength`, `in`. Usually the bare SHACL name, but not always:
   * `sh:equals` is labelled `equalsConstraint`, because a property labelled `equals`
   * would be shadowed by the query builder's own `equals()` (backlog 041). Look a
   * constraint up by label, never by assuming the predicate's local name.
   */
  label: string;
  /** The predicate IRI the constraint serializes to, e.g. `sh:pattern`. */
  predicate: string;
  /** Fixed literal datatype IRI, when the meta-model pins one (e.g. `xsd:integer` for `sh:minLength`). */
  datatype?: string;
  /** `sh:IRI` or `sh:Literal`, when the meta-model pins one (absent for the generic `sh:hasValue`). */
  nodeKind?: string;
}

let cached: Map<string, PropertyShapeTerm> | undefined;

/**
 * The SHACL constraints a `sh:PropertyShape` can carry, keyed by label — derived from the
 * core meta-model (`PropertyShape.shape`, set up in `utils/Package.ts`) rather than from a
 * hand-kept list, so a constraint added to the meta-model is immediately known here.
 *
 * This is the seam for **alternative serializers**: code that writes SHACL by a route other
 * than the create pipeline (e.g. raw SPARQL `INSERT DATA`) can look up the predicate and the
 * literal datatype for a constraint instead of re-deriving them. Constraints whose meta-model
 * path is a complex property path are omitted (they have no single predicate).
 *
 * Requires the meta-model to have been set up (importing `@_linked/core` or `utils/Package`
 * does that). The result is cached once non-empty.
 */
export function getPropertyShapeTerms(): ReadonlyMap<string, PropertyShapeTerm> {
  if (cached && cached.size) return cached;
  const map = new Map<string, PropertyShapeTerm>();
  for (const ps of PropertyShape.shape?.propertyShapes ?? []) {
    // Only single-predicate paths describe a constraint; skip complex paths.
    if (!ps.path || !isPathRef(ps.path)) continue;
    const predicate = typeof ps.path === 'string' ? ps.path : ps.path.id;
    if (!predicate) continue;
    map.set(ps.label, {
      label: ps.label,
      predicate,
      datatype: ps.datatype?.id,
      nodeKind: ps.nodeKind?.id,
    });
  }
  cached = map;
  return map;
}

/** Lookup of a single constraint by label — see {@link getPropertyShapeTerms}. */
export function getPropertyShapeTerm(label: string): PropertyShapeTerm | undefined {
  return getPropertyShapeTerms().get(label);
}
