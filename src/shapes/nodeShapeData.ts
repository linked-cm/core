/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import {Shape} from './Shape.js';

/**
 * Plain-object SHACL metadata — the QResult-like shape of a `sh:PropertyShape`.
 *
 * Shapes are metadata, not data: a shape class's `.shape` and its property shapes
 * are plain objects (no class instance, no methods). Operations that used to be
 * instance methods now live as free functions in this module.
 */
export interface PropertyShapeData {
  id: string;
  label: string;
  path: PathExpr;
  nodeKind?: NodeReferenceValue;
  datatype?: NodeReferenceValue;
  minCount?: number;
  maxCount?: number;
  name?: string;
  description?: string;
  order?: number;
  group?: string;
  class?: NodeReferenceValue;
  in?: (NodeReferenceValue | string | number | boolean)[];
  equalsConstraint?: NodeReferenceValue;
  disjoint?: NodeReferenceValue;
  lessThan?: NodeReferenceValue;
  lessThanOrEquals?: NodeReferenceValue;
  /** Value-range constraints (sh:minInclusive / sh:maxInclusive / sh:minExclusive / sh:maxExclusive). */
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number | string;
  maxExclusive?: number;
  /** String-length constraints (sh:minLength / sh:maxLength). */
  minLength?: number;
  maxLength?: number;
  /** Regex constraint (sh:pattern); serialized as its source string. */
  pattern?: RegExp;
  hasValueConstraint?: NodeReferenceValue | string | number | boolean;
  defaultValue?: unknown;
  sortBy?: PathExpr;
  valueShape?: NodeReferenceValue;
  /** Composition marker: the value(s) of this property are owned by the subject. */
  contains?: boolean;
  parentNodeShape?: NodeShapeData;
}

/**
 * Plain-object SHACL metadata — the QResult-like shape of a `sh:NodeShape`.
 */
export interface NodeShapeData {
  id: string;
  label?: string;
  description?: string;
  targetClass?: NodeReferenceValue;
  extends?: NodeReferenceValue;
  /** Composition marker: instances are dependent (cascade-deletable via `contains`). */
  dependent?: boolean;
  /** sh:closed — target nodes with undeclared properties are invalid. */
  closed?: boolean;
  /** sh:ignoredProperties — extra properties permitted when the shape is closed. */
  ignoredProperties?: NodeReferenceValue[];
  propertyShapes: PropertyShapeData[];
}

/** Result object produced by `propertyShapeToResult()` (SHACL projection). */
export interface PropertyShapeResult {
  id: string;
  label: string;
  path: PathExpr;
  nodeKind?: NodeReferenceValue;
  datatype?: NodeReferenceValue;
  minCount?: number;
  maxCount?: number;
  name?: string;
  description?: string;
  order?: number;
  group?: string;
  class?: NodeReferenceValue;
  in?: (NodeReferenceValue | string | number | boolean)[];
  equals?: NodeReferenceValue;
  disjoint?: NodeReferenceValue;
  lessThan?: NodeReferenceValue;
  lessThanOrEquals?: NodeReferenceValue;
  hasValue?: NodeReferenceValue | string | number | boolean;
  defaultValue?: unknown;
  sortBy?: PathExpr;
  valueShape?: NodeReferenceValue;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Create an empty NodeShape metadata object for the given shape IRI. */
export function createNodeShapeData(id: string): NodeShapeData {
  return {id, propertyShapes: []};
}

/** Create a blank PropertyShape metadata object (fields filled in by the caller). */
export function createPropertyShapeData(): PropertyShapeData {
  return {id: '', label: '', path: null as unknown as PathExpr};
}

// ---------------------------------------------------------------------------
// Free functions (formerly NodeShape/PropertyShape instance methods)
// ---------------------------------------------------------------------------

function ownPropertyShapes(nodeShape: NodeShapeData): PropertyShapeData[] {
  const own = (nodeShape as {propertyShapes?: PropertyShapeData[]}).propertyShapes;
  return Array.isArray(own) ? own : [];
}

/**
 * Property shapes declared on this NodeShape. With `includeSuperClasses`, walks the
 * registered shape-class inheritance chain (via `getShapeClass(nodeShape.id)`) and
 * concatenates each ancestor's own property shapes.
 */
export function getPropertyShapes(
  nodeShape: NodeShapeData,
  includeSuperClasses: boolean = false,
): PropertyShapeData[] {
  if (!includeSuperClasses) {
    return [...ownPropertyShapes(nodeShape)];
  }
  let shapeClass = getShapeClass(nodeShape.id);
  if (!shapeClass) {
    return [...ownPropertyShapes(nodeShape)];
  }
  const res: PropertyShapeData[] = [];
  while (shapeClass?.shape) {
    res.push(...ownPropertyShapes(shapeClass.shape));
    // Stop at the base Shape class.
    if ((shapeClass as unknown) === (Shape as unknown)) {
      break;
    }
    shapeClass = Object.getPrototypeOf(shapeClass);
  }
  return res;
}

/** Property shapes across the inheritance chain, deduped by label (most specific wins). */
export function getUniquePropertyShapes(
  nodeShape: NodeShapeData,
): PropertyShapeData[] {
  const unique: PropertyShapeData[] = [];
  const seen = new Set<string>();
  for (const ps of getPropertyShapes(nodeShape, true)) {
    if (!seen.has(ps.label)) {
      seen.add(ps.label);
      unique.push(ps);
    }
  }
  return unique;
}

/** Find a property shape by label, optionally walking the inheritance chain. */
export function getPropertyShape(
  nodeShape: NodeShapeData,
  label: string,
  checkSubShapes: boolean = true,
): PropertyShapeData | undefined {
  let shapeClass = getShapeClass(nodeShape.id);
  if (!shapeClass) {
    return ownPropertyShapes(nodeShape).find((ps) => ps.label === label);
  }
  let res: PropertyShapeData | undefined;
  while (!res && shapeClass?.shape) {
    res = ownPropertyShapes(shapeClass.shape).find((ps) => ps.label === label);
    if (checkSubShapes) {
      if ((shapeClass as unknown) === (Shape as unknown)) {
        break;
      }
      shapeClass = Object.getPrototypeOf(shapeClass);
    } else {
      break;
    }
  }
  return res;
}

/** Two node shapes are equal when they share the same IRI. */
export function nodeShapeEquals(a: NodeShapeData, b?: NodeShapeData): boolean {
  return !!b && a?.id === b.id;
}

/** Append a property shape to a node shape, wiring the back-reference. */
export function addPropertyShape(
  nodeShape: NodeShapeData,
  propertyShape: PropertyShapeData,
): void {
  propertyShape.parentNodeShape = nodeShape;
  if (!Array.isArray(nodeShape.propertyShapes)) {
    nodeShape.propertyShapes = [];
  }
  nodeShape.propertyShapes.push(propertyShape);
}

/** Shallow-clone a property shape (used by property override / disallow). */
export function clonePropertyShape(
  propertyShape: PropertyShapeData,
): PropertyShapeData {
  return {...propertyShape};
}

/** Project a property shape to its SHACL result object (used by introspection). */
export function propertyShapeToResult(ps: PropertyShapeData): PropertyShapeResult {
  const result: Record<string, unknown> & {id: string; label: string; path: PathExpr} = {
    id: ps.id,
    label: ps.label,
    path: ps.path,
  };
  if (ps.nodeKind) result.nodeKind = ps.nodeKind;
  if (ps.datatype) result.datatype = ps.datatype;
  if (typeof ps.minCount === 'number') result.minCount = ps.minCount;
  if (typeof ps.maxCount === 'number') result.maxCount = ps.maxCount;
  if (ps.name) result.name = ps.name;
  if (ps.description) result.description = ps.description;
  if (typeof ps.order === 'number') result.order = ps.order;
  if (ps.group) result.group = ps.group;
  if (ps.class) result.class = ps.class;
  if (ps.in) result.in = ps.in;
  if (ps.equalsConstraint) result.equals = ps.equalsConstraint;
  if (ps.disjoint) result.disjoint = ps.disjoint;
  if (ps.lessThan) result.lessThan = ps.lessThan;
  if (ps.lessThanOrEquals) result.lessThanOrEquals = ps.lessThanOrEquals;
  if (ps.minInclusive !== undefined) result.minInclusive = ps.minInclusive;
  if (ps.maxInclusive !== undefined) result.maxInclusive = ps.maxInclusive;
  if (ps.minExclusive !== undefined) result.minExclusive = ps.minExclusive;
  if (ps.maxExclusive !== undefined) result.maxExclusive = ps.maxExclusive;
  if (typeof ps.minLength === 'number') result.minLength = ps.minLength;
  if (typeof ps.maxLength === 'number') result.maxLength = ps.maxLength;
  if (ps.pattern) result.pattern = ps.pattern.source;
  if (ps.hasValueConstraint !== undefined) result.hasValue = ps.hasValueConstraint;
  if (ps.defaultValue !== undefined) result.defaultValue = ps.defaultValue;
  if (ps.sortBy) result.sortBy = ps.sortBy;
  if (ps.valueShape) result.valueShape = ps.valueShape;
  return result as PropertyShapeResult;
}
