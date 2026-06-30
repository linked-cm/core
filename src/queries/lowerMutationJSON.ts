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
  recordToRefs,
  type MutationJSON,
  type MutationNodeDataJSON,
  type MutationValueJSON,
} from './MutationSerialization.js';

function requireShape(shapeId: string): NodeShape {
  const shape = getShapeClass(shapeId)?.shape;
  if (!shape) {
    throw new Error(
      `Shape '${shapeId}' is not registered. The receiving side must have the shape registered to lower mutation DSL-JSON.`,
    );
  }
  return shape;
}

/** Decode a tagged value to the normalized form the canonical-IR builders consume. */
function decodeValue(json: MutationValueJSON): PropUpdateValue {
  switch (json.kind) {
    case 'unset':
      return undefined;
    case 'lit':
      return json.value;
    case 'date':
      return new Date(json.value);
    case 'ref':
      return {id: json.id};
    case 'ctxRef': {
      // Lowering path: a mutation must hit a concrete node, so resolve the
      // context now and throw if it isn't set.
      const id = resolveContextId(json.name, true)!;
      return {id} as PropUpdateValue;
    }
    case 'node':
      return decodeNodeData(json.data) as unknown as PropUpdateValue;
    case 'array':
      return json.items.map(
        (item) => decodeValue(item) as SinglePropertyUpdateValue,
      );
    case 'setMod': {
      const mod: SetModificationValue = {};
      if (json.add) {
        mod.$add = json.add.map((v) => decodeValue(v)) as SetModificationValue['$add'];
      }
      if (json.remove) mod.$remove = json.remove.map((id) => ({id}));
      return mod as PropUpdateValue;
    }
    case 'expr':
      return new ExpressionNode(
        json.ir,
        recordToRefs(json.refs),
      ) as unknown as PropUpdateValue;
  }
}

/** Rebuild a normalized node description from JSON, resolving labels via the shape. */
export function decodeNodeData(json: MutationNodeDataJSON): NodeDescriptionValue {
  const shape = requireShape(json.shape);
  const fields: UpdateNodePropertyValue[] = json.fields.map((f) => {
    const prop = shape.getPropertyShape(f.prop);
    if (!prop) {
      throw new Error(
        `Property '${f.prop}' not found on shape '${shape.label || shape.id}'`,
      );
    }
    return {prop, val: decodeValue(f.value)} as UpdateNodePropertyValue;
  });
  const desc: NodeDescriptionValue = {shape, fields};
  if (json.id) desc.__id = json.id;
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
    case 'create':
      return buildCanonicalCreateMutationIR({
        shape: requireShape(json.shape),
        description: decodeNodeData(json.data),
      });
    case 'update': {
      const shape = requireShape(json.shape);
      const updates = decodeNodeData(json.data);
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
