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
import type {IRExpression} from './IntermediateRepresentation.js';
import type {WherePathJSON} from './QueryBuilderSerialization.js';
import type {ContextRefJSON} from './ContextRef.js';
import {PendingQueryContext} from './QueryContext.js';

// =============================================================================
// JSON types
// =============================================================================

export type MutationValueJSON =
  | {kind: 'lit'; value: string | number | boolean}
  | {kind: 'date'; value: string}
  | {kind: 'ref'; id: string}
  | {kind: 'ctxRef'; name: string}
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
    // Query-context reference — carry the name, resolve at lowering (checked
    // before the generic `.id` branch since a PendingQueryContext has an `.id` getter).
    if (value instanceof PendingQueryContext) {
      return {kind: 'ctxRef', name: value.contextName};
    }
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

// =============================================================================
// JSON → raw UpdatePartial (for builder rehydration / fromJSON)
// =============================================================================

/** Decode a tagged value back to a raw DSL value (the form `.set()` accepts). */
function decodeValueToRaw(json: MutationValueJSON): unknown {
  switch (json.kind) {
    case 'unset':
      return undefined;
    case 'lit':
      return json.value;
    case 'date':
      return new Date(json.value);
    case 'ref':
      return {id: json.id};
    case 'ctxRef':
      // Rehydration path: preserve the live reference so it re-serializes as a
      // `{$ctx}` marker and resolves at the rebuilt builder's own lowering.
      return new PendingQueryContext(json.name);
    case 'node':
      return decodeNodeDataToRaw(json.data);
    case 'array':
      return json.items.map(decodeValueToRaw);
    case 'setMod': {
      // Raw DSL set-modifications use `add`/`remove` (the normalized form uses $add/$remove).
      const mod: {add?: unknown[]; remove?: {id: string}[]} = {};
      if (json.add) mod.add = json.add.map(decodeValueToRaw);
      if (json.remove) mod.remove = json.remove.map((id) => ({id}));
      return mod;
    }
    case 'expr':
      return new ExpressionNode(json.ir, recordToRefs(json.refs));
  }
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
  for (const f of json.fields) obj[f.prop] = decodeValueToRaw(f.value);
  return obj;
}
