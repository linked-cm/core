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
 * Translate a `PathExpr` into create-pipeline node-data for `sh:path`.
 *
 * - simple `PathRef` → `{id}` (a shared predicate IRI; NOT owned)
 * - sequence → an `rdf:List` of segments (via {@link rdfList})
 * - inverse / alternative / cardinality → a `PathNode` operator node (alt's operand is an `rdf:List`)
 *
 * `base` seeds deterministic ids for the minted owned nodes (`{base}/inv`, `{base}/seq/0`, …) so a
 * re-sync overwrites them in place; the owned subtree is cleaned by the containment cascade.
 */
export function serializePathToNodeData(path: PathExpr, base: string): PathNodeData {
  const serialize = (e: PathExpr, b: string): PathNodeData => {
    if (isPathRef(e)) {
      return {id: typeof e === 'string' ? e : e.id};
    }
    if ('seq' in e) {
      // SHACL §2.3.1: a sequence path is a list with **at least two** members.
      // A 0/1-member sequence is not a list — collapse a singleton to its bare
      // member, reject an empty one. (normalizePropertyPath already collapses
      // these upstream; this keeps the serializer independently spec-correct.)
      if (e.seq.length === 0) {
        throw new Error('Cannot serialize an empty sequence path to SHACL sh:path.');
      }
      if (e.seq.length === 1) return serialize(e.seq[0], `${b}/seq/0`);
      return rdfList(
        e.seq.map((s, i) => serialize(s, `${b}/seq/${i}`)),
        {base: `${b}/seq`},
      ) as PathNodeData;
    }
    if ('inv' in e) {
      return {shape: PathNode, __id: `${b}/inv`, inversePath: serialize(e.inv, `${b}/inv`)};
    }
    if ('alt' in e) {
      // SHACL §2.3.2: sh:alternativePath is a list with **at least two** members.
      // Collapse a singleton alternative to its bare member, reject an empty one.
      if (e.alt.length === 0) {
        throw new Error('Cannot serialize an empty alternative path to SHACL sh:path.');
      }
      if (e.alt.length === 1) return serialize(e.alt[0], `${b}/alt/0`);
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
