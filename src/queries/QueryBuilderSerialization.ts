/**
 * Serialization helpers for QueryBuilder fields that contain live object
 * references (where-clauses, sort paths, minus entries).
 *
 * Where-clauses serialize through the Z-c expression codec
 * (`ZcExpression.ts`) — the wire form carries no IR. This module wires that
 * codec into the select/mutation envelopes and handles sort + minus.
 */

import type {NodeShape} from '../shapes/SHACL.js';
import {walkPropertyPath} from './PropertyPath.js';
import type {WherePath, SortByPath} from './SelectQuery.js';
import type {RawMinusEntry, PropertyPathSegment} from './IRDesugar.js';
import {
  encodeCondition,
  decodeCondition,
  type ZcCondition,
} from './ZcExpression.js';
import {ExpressionNode, ExistsCondition} from '../expressions/ExpressionNode.js';

// =============================================================================
// JSON types
// =============================================================================

/** A where-clause on the wire is a Z-c condition (see documentation/dsl-json.md). */
export type WherePathJSON = ZcCondition;

/** An ordered list of `{path: direction}` — element order is sort precedence. */
export type SortByPathJSON = Array<{[path: string]: 'ASC' | 'DESC'}>;

export type RawMinusEntryJSON = {
  shapeId?: string;
  where?: WherePathJSON;
  propertyPaths?: string[][];
};

// =============================================================================
// Serialization
// =============================================================================

/** Serialize a runtime where-clause to its Z-c condition form. */
export function serializeWherePath(
  where: WherePath,
  shape: NodeShape,
): WherePathJSON {
  const node: ExpressionNode | ExistsCondition =
    'existsCondition' in (where as object)
      ? (where as {existsCondition: ExistsCondition}).existsCondition
      : (where as {expressionNode: ExpressionNode}).expressionNode;
  return encodeCondition(node, shape);
}

export function serializeSortByPath(sort: SortByPath): SortByPathJSON {
  return sort.paths.map((p) => ({[p.toString()]: sort.direction}));
}

export function serializeRawMinusEntry(
  entry: RawMinusEntry,
  shape: NodeShape,
): RawMinusEntryJSON {
  const json: RawMinusEntryJSON = {};
  if (entry.shapeId) json.shapeId = entry.shapeId;
  if (entry.where) json.where = serializeWherePath(entry.where, shape);
  if (entry.propertyPaths) {
    json.propertyPaths = entry.propertyPaths.map((pp) =>
      pp.map((seg) => seg.propertyShapeId),
    );
  }
  return json;
}

// =============================================================================
// Deserialization
// =============================================================================

/** Rebuild a runtime where-clause from its Z-c condition form. */
export function deserializeWherePath(
  shape: NodeShape,
  json: WherePathJSON,
): WherePath {
  return decodeCondition(json, shape);
}

export function deserializeSortByPath(
  shape: NodeShape,
  json: SortByPathJSON,
): SortByPath {
  return {
    paths: json.map((e) => walkPropertyPath(shape, Object.keys(e)[0])),
    direction: (json.length ? Object.values(json[0])[0] : 'ASC') as 'ASC' | 'DESC',
  };
}

export function deserializeRawMinusEntry(
  shape: NodeShape,
  json: RawMinusEntryJSON,
): RawMinusEntry {
  const entry: RawMinusEntry = {};
  if (json.shapeId) entry.shapeId = json.shapeId;
  if (json.where) entry.where = deserializeWherePath(shape, json.where);
  if (json.propertyPaths) {
    entry.propertyPaths = json.propertyPaths.map((pp) =>
      pp.map((id): PropertyPathSegment => ({propertyShapeId: id})),
    );
  }
  return entry;
}
