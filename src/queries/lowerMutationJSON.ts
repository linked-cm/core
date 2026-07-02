/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Lower mutation DSL-JSON to canonical IR.
 *
 * This is the **IR side** of mutation (de)serialization, kept deliberately
 * separate from the IR-free wire codec in `MutationSerialization.ts`. The
 * canonical-IR builders (`IRMutation` / `IRLower` / …) are reachable only from
 * here and from `lower()`, so a client that serializes mutations to JSON and
 * forwards them (without ever lowering) tree-shakes the whole IR pipeline away.
 */
import type {NodeShape} from '../shapes/SHACL.js';
import {
  type NodeDescriptionValue,
  type PropUpdateValue,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  type UpdateNodePropertyValue,
} from './QueryFactory.js';
import {ExpressionNode} from '../expressions/ExpressionNode.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import type {IRExpression, IRGraphPattern} from './IntermediateRepresentation.js';
import {
  deserializeWherePath,
  type WherePathJSON,
} from './QueryBuilderSerialization.js';
import {toWhere} from './IRDesugar.js';
import {canonicalizeWhere} from './IRCanonicalize.js';
import {lowerWhereToIR} from './IRLower.js';
import {
  buildCanonicalCreateMutationIR,
  buildCanonicalUpdateMutationIR,
  buildCanonicalUpdateWhereMutationIR,
  buildCanonicalDeleteMutationIR,
  buildCanonicalDeleteAllMutationIR,
  buildCanonicalDeleteWhereMutationIR,
} from './IRMutation.js';
import type {IRCreateQuery} from './CreateQuery.js';
import type {IRUpdateQuery} from './UpdateQuery.js';
import type {IRDeleteQuery} from './DeleteQuery.js';
import {isContextRefJSON, resolveContextId} from './ContextRef.js';
import {assertWireVersion} from './wireVersion.js';
import {
  valueShapeOf,
  type MutationJSON,
  type MutationNodeDataJSON,
  type MutationValueJSON,
} from './MutationSerialization.js';
import {decodeValueExpr, type ZcValue} from './ZcExpression.js';
import type {PropertyShape} from '../shapes/SHACL.js';

function requireShape(shapeId: string): NodeShape {
  const shape = getShapeClass(shapeId)?.shape;
  if (!shape) {
    throw new Error(
      `Shape '${shapeId}' is not registered. The receiving side must have the shape registered to lower mutation DSL-JSON.`,
    );
  }
  return shape;
}

/**
 * Decode a Z-c value to the normalized form the canonical-IR builders consume.
 * `currentShape` resolves computed `{path}`/S-expr; `prop` gives a nested node's shape.
 */
function decodeValue(
  json: MutationValueJSON,
  currentShape: NodeShape,
  prop?: PropertyShape,
): PropUpdateValue {
  // S-expr computed value (no IR on the wire)
  if (Array.isArray(json)) {
    const {ir, refs} = decodeValueExpr(json as ZcValue, currentShape);
    return new ExpressionNode(ir, refs) as unknown as PropUpdateValue;
  }
  if (json === null) return null as unknown as PropUpdateValue;
  if (typeof json !== 'object') return json as PropUpdateValue; // bare scalar literal
  const o = json as Record<string, unknown>;
  if ('unset' in o) return undefined;
  if ('date' in o) return new Date(o.date as string) as unknown as PropUpdateValue;
  if ('$ctx' in o) {
    // Lowering path: a mutation must hit a concrete node, so resolve the
    // context now and throw if it isn't set.
    const id = resolveContextId(o.$ctx as string, true)!;
    return {id} as PropUpdateValue;
  }
  if ('id' in o) return {id: o.id} as PropUpdateValue;
  if ('list' in o) {
    return (o.list as MutationValueJSON[]).map(
      (item) => decodeValue(item, currentShape, prop) as SinglePropertyUpdateValue,
    );
  }
  if ('add' in o || 'remove' in o) {
    const mod: SetModificationValue = {};
    if (o.add) {
      mod.$add = (o.add as MutationValueJSON[]).map((v) =>
        decodeValue(v, currentShape, prop),
      ) as SetModificationValue['$add'];
    }
    if (o.remove) mod.$remove = (o.remove as string[]).map((id) => ({id}));
    return mod as PropUpdateValue;
  }
  if ('path' in o) {
    const {ir, refs} = decodeValueExpr(json as ZcValue, currentShape);
    return new ExpressionNode(ir, refs) as unknown as PropUpdateValue;
  }
  // Otherwise: a bare path-keyed nested-node create.
  return decodeNodeData(
    o as MutationNodeDataJSON,
    valueShapeOf(prop) ?? currentShape,
  ) as unknown as PropUpdateValue;
}

/**
 * Rebuild a normalized node description from path-keyed JSON, resolving labels via the
 * shape. `shape` is the shape inferred from context; `__shape` overrides it.
 */
export function decodeNodeData(
  json: MutationNodeDataJSON,
  shape?: NodeShape,
): NodeDescriptionValue {
  const nodeShape =
    typeof json.__shape === 'string' ? requireShape(json.__shape) : shape!;
  const fields: UpdateNodePropertyValue[] = [];
  for (const [key, val] of Object.entries(json)) {
    if (key === '__id' || key === '__shape' || val === undefined) continue;
    const prop = nodeShape.getPropertyShape(key);
    if (!prop) {
      throw new Error(
        `Property '${key}' not found on shape '${nodeShape.label || nodeShape.id}'`,
      );
    }
    fields.push({prop, val: decodeValue(val as MutationValueJSON, nodeShape, prop)} as UpdateNodePropertyValue);
  }
  const desc: NodeDescriptionValue = {shape: nodeShape, fields};
  if (typeof json.__id === 'string') desc.__id = json.__id;
  return desc;
}

function lowerWhere(
  shape: NodeShape,
  json: WherePathJSON,
): {where: IRExpression; wherePatterns: IRGraphPattern[]} {
  const wherePath = deserializeWherePath(shape, json);
  const canonical = canonicalizeWhere(toWhere(wherePath));
  return lowerWhereToIR(canonical);
}

/**
 * Lower a mutation DSL-JSON envelope to the canonical IR mutation the dataset
 * expects. Mirrors the IR that `lower()` produces from the live builder.
 */
export function lowerMutationJSON(
  json: MutationJSON,
): IRCreateQuery | IRUpdateQuery | IRDeleteQuery {
  assertWireVersion(json.v);
  switch (json.op) {
    case 'create': {
      const shape = requireShape(json.shape);
      return buildCanonicalCreateMutationIR({
        shape,
        description: decodeNodeData(json.data, shape),
      });
    }
    case 'update': {
      const shape = requireShape(json.shape);
      const updates = decodeNodeData(json.data, shape);
      if (json.mode === 'for') {
        // A `{$ctx}` target resolves against the current context map; a mutation
        // must hit a concrete subject, so an unresolved context throws.
        const id = isContextRefJSON(json.targetId)
          ? resolveContextId(json.targetId.$ctx, true)
          : json.targetId;
        if (!id) {
          throw new Error('update mode "for" requires a targetId');
        }
        return buildCanonicalUpdateMutationIR({id, shape, updates});
      }
      let where: IRExpression | undefined;
      let wherePatterns: IRGraphPattern[] | undefined;
      if (json.mode === 'where') {
        if (!json.where) throw new Error('update mode "where" requires a where clause');
        ({where, wherePatterns} = lowerWhere(shape, json.where));
      }
      return buildCanonicalUpdateWhereMutationIR({shape, updates, where, wherePatterns});
    }
    case 'delete': {
      const shape = requireShape(json.shape);
      if (json.mode === 'ids') {
        return buildCanonicalDeleteMutationIR({
          shape,
          // A `{$ctx}` id resolves against the live map; a delete must hit a
          // concrete node, so an unresolved context throws.
          ids: json.ids.map((id) =>
            isContextRefJSON(id) ? {id: resolveContextId(id.$ctx, true)!} : {id},
          ),
        });
      }
      if (json.mode === 'all') {
        return buildCanonicalDeleteAllMutationIR({shape});
      }
      const {where, wherePatterns} = lowerWhere(shape, json.where);
      return buildCanonicalDeleteWhereMutationIR({shape, where, wherePatterns});
    }
  }
}
