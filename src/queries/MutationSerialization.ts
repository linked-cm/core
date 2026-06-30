/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Lossless JSON (de)serialization for mutations (create / update / delete) — the
 * **IR-free wire codec**. The companion IR side (`decodeNodeData` / `lowerMutationJSON`)
 * lives in `lowerMutationJSON.ts` so this module never pulls the canonical-IR pipeline.
 *
 * The serialization unit is the normalized `NodeDescriptionValue` produced by the
 * IR-free factory base (`MutationQueryFactory.describe()`) — i.e. after `.set()` and
 * after any update-expression callback has been evaluated, but before canonical IR.
 * Property keys are serialized as **labels** (shape-relative, lightweight); decoding
 * resolves them back via the registered shape.
 *
 * `JSON.stringify` is lossy for three of the value kinds (`Date` collapses to a
 * string, `ExpressionNode` is a live object, `undefined` is dropped), so each is
 * given an explicit tagged encoding.
 */
import {
  type NodeDescriptionValue,
  type NodeReferenceValue,
  type PropUpdateValue,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  isSetModificationValue,
} from './QueryFactory.js';
import {ExpressionNode, isExpressionNode} from '../expressions/ExpressionNode.js';
import type {WherePathJSON} from './QueryBuilderSerialization.js';
import type {ContextRefJSON} from './ContextRef.js';
import {PendingQueryContext} from './QueryContext.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import type {NodeShape} from '../shapes/SHACL.js';
import {
  encodeValueExpr,
  decodeValueExpr,
  type ZcValue,
} from './ZcExpression.js';

// =============================================================================
// JSON types
// =============================================================================

/**
 * A mutation field value in the Z-c grammar. A bare scalar is a literal; objects
 * tag the non-JSON-native kinds; a computed value is an S-expr array (no IR). The
 * `{shape, fields}` node envelope is kept so nested nodes stay self-describing.
 */
export type MutationValueJSON =
  | string
  | number
  | boolean
  | null
  | {date: string}
  | {id: string}
  | {$ctx: string}
  | {list: MutationValueJSON[]}
  | {add?: MutationValueJSON[]; remove?: string[]}
  | {node: MutationNodeDataJSON}
  | {unset: true}
  | ZcValue; // computed expression (S-expr) / {path}

export type MutationFieldJSON = {prop: string; value: MutationValueJSON};

export type MutationNodeDataJSON = {
  shape: string;
  id?: string;
  fields: MutationFieldJSON[];
};

export type CreateMutationJSON = {
  v?: string;
  op: 'create';
  shape: string;
  data: MutationNodeDataJSON;
};

export type UpdateMutationJSON = {
  v?: string;
  op: 'update';
  shape: string;
  mode: 'for' | 'forAll' | 'where';
  /** A node id, or a `{$ctx: name}` context reference resolved at lowering. */
  targetId?: string | ContextRefJSON;
  where?: WherePathJSON;
  data: MutationNodeDataJSON;
};

export type DeleteMutationJSON =
  | {v?: string; op: 'delete'; shape: string; mode: 'ids'; ids: (string | ContextRefJSON)[]}
  | {v?: string; op: 'delete'; shape: string; mode: 'all'}
  | {v?: string; op: 'delete'; shape: string; mode: 'where'; where: WherePathJSON};

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

export function recordToRefs(
  refs?: Record<string, string[]>,
): Map<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  if (refs) for (const [k, v] of Object.entries(refs)) m.set(k, v);
  return m;
}

/** Encode a single (non-array, non-setMod) property value. */
function encodeSingleValue(value: SinglePropertyUpdateValue): MutationValueJSON {
  if (value === undefined) return {unset: true};
  if (isExpressionNode(value)) {
    // A computed value is an S-expr (or {path}) via the shared codec — no IR.
    return encodeValueExpr(value.ir, value._refs) as MutationValueJSON;
  }
  if (value instanceof Date) return {date: value.toISOString()};
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value && typeof value === 'object') {
    // Query-context reference — carry the name, resolve at lowering (checked
    // before the generic `.id` branch since a PendingQueryContext has an `.id` getter).
    if (value instanceof PendingQueryContext) {
      return {$ctx: value.contextName};
    }
    if ('fields' in value) {
      return {node: encodeNodeData(value as NodeDescriptionValue)};
    }
    if ('id' in value) return {id: (value as NodeReferenceValue).id};
  }
  throw new Error(`Cannot serialize mutation value: ${JSON.stringify(value)}`);
}

/** Encode any property value, including arrays and set modifications. */
export function encodeValue(value: PropUpdateValue): MutationValueJSON {
  if (value === undefined) return {unset: true};
  if (Array.isArray(value)) {
    return {list: value.map(encodeSingleValue)};
  }
  if (isSetModificationValue(value)) {
    const mod = value as SetModificationValue;
    const json: {add?: MutationValueJSON[]; remove?: string[]} = {};
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

// =============================================================================
// JSON → raw UpdatePartial (for builder rehydration / fromJSON)
// =============================================================================

/** Decode a Z-c value back to a raw DSL value (the form `.set()` accepts). */
function decodeValueToRaw(json: MutationValueJSON, shape: NodeShape | undefined): unknown {
  // S-expr computed value
  if (Array.isArray(json)) {
    const {ir, refs} = decodeValueExpr(json as ZcValue, requireShapeForExpr(shape));
    return new ExpressionNode(ir, refs);
  }
  if (json === null) return null;
  if (typeof json !== 'object') return json; // bare scalar literal
  const o = json as Record<string, unknown>;
  if ('unset' in o) return undefined;
  if ('date' in o) return new Date(o.date as string);
  if ('node' in o) return decodeNodeDataToRaw(o.node as MutationNodeDataJSON);
  // Rehydration path: preserve the live reference so it re-serializes as a
  // `{$ctx}` marker and resolves at the rebuilt builder's own lowering.
  if ('$ctx' in o) return new PendingQueryContext(o.$ctx as string);
  if ('id' in o) return {id: o.id};
  if ('list' in o) {
    return (o.list as MutationValueJSON[]).map((i) => decodeValueToRaw(i, shape));
  }
  if ('add' in o || 'remove' in o) {
    // Raw DSL set-modifications use `add`/`remove` (the normalized form uses $add/$remove).
    const mod: {add?: unknown[]; remove?: {id: string}[]} = {};
    if (o.add) mod.add = (o.add as MutationValueJSON[]).map((i) => decodeValueToRaw(i, shape));
    if (o.remove) mod.remove = (o.remove as string[]).map((id) => ({id}));
    return mod;
  }
  // A computed-path value (`{path}`) used as a value.
  if ('path' in o) {
    const {ir, refs} = decodeValueExpr(json as ZcValue, requireShapeForExpr(shape));
    return new ExpressionNode(ir, refs);
  }
  throw new Error(`Cannot decode mutation value: ${JSON.stringify(json)}`);
}

function requireShapeForExpr(shape: NodeShape | undefined): NodeShape {
  if (!shape) {
    throw new Error('A shape is required to decode a computed mutation value');
  }
  return shape;
}

/**
 * Decode a node-data JSON into a raw object the mutation builders' `.set()` accepts.
 * A top-level `id` is preserved (predefined id / fixed id); the factory turns it into
 * the node's id. Mirrors {@link encodeNodeData}.
 */
export function decodeNodeDataToRaw(
  json: MutationNodeDataJSON,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (json.id) obj.id = json.id;
  const shape = getShapeClass(json.shape)?.shape;
  for (const f of json.fields) obj[f.prop] = decodeValueToRaw(f.value, shape);
  return obj;
}
