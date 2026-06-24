/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {isPathRef} from '../paths/PropertyPathExpr.js';
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {List, rdfList} from './List.js';
import {PathNode} from './PathNode.js';

/**
 * Node-data the create pipeline accepts for a `sh:path` value: an IRI reference (simple path),
 * an `rdf:List` (sequence / alternative members), or a `PathNode` operator node.
 */
export type PathNodeData =
  | NodeReferenceValue
  | {shape: typeof List | typeof PathNode; __id?: string; [k: string]: unknown};

/**
 * Translate a `PathExpr` into create-pipeline node-data for `sh:path` (plan-001 D9).
 *
 * - simple `PathRef` → `{id}` (a shared predicate IRI; NOT owned)
 * - sequence → an `rdf:List` of segments (via {@link rdfList})
 * - inverse / alternative / cardinality → a `PathNode` operator node (alt's operand is an `rdf:List`)
 *
 * `base` seeds deterministic ids for the minted owned nodes (`{base}/inv`, `{base}/seq/0`, …) so a
 * re-sync overwrites them in place; the owned subtree is cleaned by the containment cascade (P4).
 */
export function serializePathToNodeData(path: PathExpr, base: string): PathNodeData {
  const serialize = (e: PathExpr, b: string): PathNodeData => {
    if (isPathRef(e)) {
      return {id: typeof e === 'string' ? e : e.id};
    }
    if ('seq' in e) {
      return rdfList(
        e.seq.map((s, i) => serialize(s, `${b}/seq/${i}`)),
        {base: `${b}/seq`},
      ) as PathNodeData;
    }
    if ('inv' in e) {
      return {shape: PathNode, __id: `${b}/inv`, inversePath: serialize(e.inv, `${b}/inv`)};
    }
    if ('alt' in e) {
      return {
        shape: PathNode,
        __id: `${b}/alt`,
        alternativePath: rdfList(
          e.alt.map((a, i) => serialize(a, `${b}/alt/${i}`)),
          {base: `${b}/alt`},
        ),
      };
    }
    if ('zeroOrMore' in e) {
      return {shape: PathNode, __id: `${b}/zom`, zeroOrMorePath: serialize(e.zeroOrMore, `${b}/zom`)};
    }
    if ('oneOrMore' in e) {
      return {shape: PathNode, __id: `${b}/oom`, oneOrMorePath: serialize(e.oneOrMore, `${b}/oom`)};
    }
    if ('zeroOrOne' in e) {
      return {shape: PathNode, __id: `${b}/zoo`, zeroOrOnePath: serialize(e.zeroOrOne, `${b}/zoo`)};
    }
    if ('negatedPropertySet' in e) {
      throw new Error(
        'negatedPropertySet cannot be serialized to SHACL sh:path — no SHACL representation.',
      );
    }
    throw new Error(`Unknown PathExpr shape: ${JSON.stringify(e)}`);
  };
  return serialize(path, base);
}
