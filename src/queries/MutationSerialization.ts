/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Lossless JSON (de)serialization for mutations (create / update / delete).
 *
 * The serialization unit is the normalized `NodeDescriptionValue` produced by the
 * mutation factories (`CreateQueryFactory.description` / `UpdateQueryFactory.fields`)
 * — i.e. after `.set()` and after any update-expression callback has been evaluated,
 * but before canonical IR. Property keys are serialized as **labels** (shape-relative,
 * lightweight); decoding resolves them back to `PropertyShape`s via the registered
 * shape and then calls the same `buildCanonical*MutationIR` functions the builders
 * use — so the round-trip reproduces identical IR.
 *
 * `JSON.stringify` is lossy for three of the value kinds (`Date` collapses to a
 * string, `ExpressionNode` is a live object, `undefined` is dropped), so each is
 * given an explicit tagged encoding.
 */
import type {NodeShape} from '../shapes/SHACL.js';
import {
  type NodeDescriptionValue,
  type NodeReferenceValue,
  type PropUpdateValue,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  type UpdateNodePropertyValue,
  isSetModificationValue,
} from './QueryFactory.js';
import {ExpressionNode, isExpressionNode} from '../expressions/ExpressionNode.js';
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

// =============================================================================
// JSON types
// =============================================================================

export type MutationValueJSON =
  | {kind: 'lit'; value: string | number | boolean}
  | {kind: 'date'; value: string}
  | {kind: 'ref'; id: string}
  | {kind: 'node'; data: MutationNodeDataJSON}
  | {kind: 'array'; items: MutationValueJSON[]}
  | {kind: 'setMod'; add?: MutationValueJSON[]; remove?: string[]}
  | {kind: 'expr'; ir: IRExpression; refs?: Record<string, string[]>}
  | {kind: 'unset'};

export type MutationFieldJSON = {prop: string; value: MutationValueJSON};

export type MutationNodeDataJSON = {
  shape: string;
  id?: string;
  fields: MutationFieldJSON[];
};

export type CreateMutationJSON = {
  op: 'create';
  shape: string;
  data: MutationNodeDataJSON;
};

export type UpdateMutationJSON = {
  op: 'update';
  shape: string;
  mode: 'for' | 'forAll' | 'where';
  targetId?: string;
  where?: WherePathJSON;
  data: MutationNodeDataJSON;
};

export type DeleteMutationJSON =
  | {op: 'delete'; shape: string; mode: 'ids'; ids: string[]}
  | {op: 'delete'; shape: string; mode: 'all'}
  | {op: 'delete'; shape: string; mode: 'where'; where: WherePathJSON};

export type MutationJSON =
  | CreateMutationJSON
  | UpdateMutationJSON
  | DeleteMutationJSON;

// =============================================================================
// Value codec
// =============================================================================

function refsToRecord(
  refs: ReadonlyMap<string, readonly string[]>,
): Record<string, string[]> | undefined {
  if (!refs || refs.size === 0) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of refs) out[k] = [...v];
  return out;
}

function recordToRefs(
  refs?: Record<string, string[]>,
): Map<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  if (refs) for (const [k, v] of Object.entries(refs)) m.set(k, v);
  return m;
}

/** Encode a single (non-array, non-setMod) property value. */
function encodeSingleValue(value: SinglePropertyUpdateValue): MutationValueJSON {
  if (value === undefined) return {kind: 'unset'};
  if (isExpressionNode(value)) {
    const json: MutationValueJSON = {kind: 'expr', ir: value.ir};
    const refs = refsToRecord(value._refs);
    if (refs) (json as {refs?: Record<string, string[]>}).refs = refs;
    return json;
  }
  if (value instanceof Date) return {kind: 'date', value: value.toISOString()};
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {kind: 'lit', value};
  }
  if (value && typeof value === 'object') {
    if ('fields' in value) {
      return {kind: 'node', data: encodeNodeData(value as NodeDescriptionValue)};
    }
    if ('id' in value) return {kind: 'ref', id: (value as NodeReferenceValue).id};
  }
  throw new Error(`Cannot serialize mutation value: ${JSON.stringify(value)}`);
}

/** Encode any property value, including arrays and set modifications. */
export function encodeValue(value: PropUpdateValue): MutationValueJSON {
  if (value === undefined) return {kind: 'unset'};
  if (Array.isArray(value)) {
    return {kind: 'array', items: value.map(encodeSingleValue)};
  }
  if (isSetModificationValue(value)) {
    const mod = value as SetModificationValue;
    const json: {kind: 'setMod'; add?: MutationValueJSON[]; remove?: string[]} = {
      kind: 'setMod',
    };
    if (mod.$add) json.add = mod.$add.map((v) => encodeValue(v as PropUpdateValue));
    if (mod.$remove) json.remove = mod.$remove.map((r) => r.id);
    return json;
  }
  return encodeSingleValue(value as SinglePropertyUpdateValue);
}

/** Encode a normalized node description (shape + label-keyed fields + optional id). */
export function encodeNodeData(desc: NodeDescriptionValue): MutationNodeDataJSON {
  const json: MutationNodeDataJSON = {
    shape: desc.shape.id,
    fields: desc.fields.map((f) => ({
      prop: f.prop.label,
      value: encodeValue(f.val),
    })),
  };
  if (desc.__id) json.id = desc.__id;
  return json;
}

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

function requireShape(shapeId: string): NodeShape {
  const shape = getShapeClass(shapeId)?.shape;
  if (!shape) {
    throw new Error(
      `Shape '${shapeId}' is not registered. The receiving side must have the shape registered to lower mutation DSL-JSON.`,
    );
  }
  return shape;
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

// =============================================================================
// Lowering (JSON → canonical IR mutation)
// =============================================================================

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
 * expects. Mirrors the builders' `build()` output for every supported feature.
 */
export function lowerMutationJSON(
  json: MutationJSON,
): IRCreateQuery | IRUpdateQuery | IRDeleteQuery {
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
        if (!json.targetId) {
          throw new Error('update mode "for" requires a targetId');
        }
        return buildCanonicalUpdateMutationIR({id: json.targetId, shape, updates});
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
          ids: json.ids.map((id) => ({id})),
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
