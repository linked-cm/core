/**
 * Z-c expression codec — the bidirectional bridge between the runtime
 * expression IR (`ExpressionNode` = `{ir, refs}`, `ExistsCondition`) and the
 * Z-c DSL-JSON grammar (documentation/dsl-json.md).
 *
 * Two tiers:
 *  - VALUE   (`encodeValueExpr`/`decodeValueExpr`): a computed value or an
 *            operand — bare scalar, `{path}`, `{id}`, `{$ctx}`, `{date}`,
 *            `{list}`, or an S-expr array `["op", …]`.
 *  - CONDITION (`encodeCondition`/`decodeCondition`): a boolean where-clause —
 *            path-keyed object (implicit equals / operator map / quantifier),
 *            `{and|or|not}`, or an S-expr array fallback.
 *
 * The codec is pure and shape-aware: it resolves property labels against the
 * supplied `NodeShape`, and never touches builder internals. Function and
 * aggregate names are kept verbatim from the IR (e.g. `STRLEN`, `count`) — no
 * name map, lossless round-trip. Round-trip-through-`lower` is the contract.
 */
import type {
  IRExpression,
  IRBinaryOperator,
} from './IntermediateRepresentation.js';
import {
  ExpressionNode,
  ExistsCondition,
  type PropertyRefMap,
  tracedPropertyExpression,
  tracedAliasExpression,
} from '../expressions/ExpressionNode.js';
import type {NodeShape} from '../shapes/SHACL.js';
import type {WherePath} from './SelectQuery.js';
import {walkPropertyPath} from './PropertyPath.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type ZcScalar = string | number | boolean | null;
export type ZcRef = {id: string};
export type ZcCtx = {$ctx: string; path?: string};
export type ZcDate = {date: string};
export type ZcList = {list: ZcValue[]};
export type ZcPath = {path: string};
export type ZcSExpr = [string, ...ZcValue[]];
export type ZcValue =
  | ZcScalar
  | ZcRef
  | ZcCtx
  | ZcDate
  | ZcList
  | ZcPath
  | ZcSExpr;

export type ZcOpMap = {[op: string]: ZcValue};
/**
 * A Z-c condition: an S-expr array, or a keyed object whose keys are property
 * paths (→ value / operator-map), quantifier keys like `rel.some` (→ a nested
 * condition), or combinators `and`/`or` (→ a condition array) / `not` (→ a
 * condition). The permissive index reflects the structural wire shape.
 */
export type ZcCondition =
  | ZcSExpr
  | {[key: string]: ZcValue | ZcOpMap | ZcCondition | ZcCondition[]};

const COMPARISON_OPS = new Set<IRBinaryOperator>([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
]);

const COMBINATORS = new Set(['and', 'or', 'not']);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** PropertyShape id = `{shapeId}/{label}` (SHACL.ts), so the label is the last segment. */
function labelOf(segmentIri: string): string {
  const i = segmentIri.lastIndexOf('/');
  return i >= 0 ? segmentIri.slice(i + 1) : segmentIri;
}

/** Property-shape IRIs → a dotted label path. */
export function segmentsToPath(segmentIds: readonly string[]): string {
  return segmentIds.map(labelOf).join('.');
}

/** A dotted label path → its property-shape IRIs, resolved against `shape`. */
export function pathToSegmentIds(shape: NodeShape, path: string): string[] {
  return walkPropertyPath(shape, path).segments.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// refs merging
// ---------------------------------------------------------------------------

function mergeRefs(into: Map<string, readonly string[]>, from: PropertyRefMap): void {
  for (const [k, v] of from) into.set(k, v);
}

// ---------------------------------------------------------------------------
// VALUE tier
// ---------------------------------------------------------------------------

/** Encode an IR expression used as a value/operand into a Z-c value. */
export function encodeValueExpr(
  ir: IRExpression,
  refs: PropertyRefMap,
): ZcValue {
  switch (ir.kind) {
    case 'literal_expr': {
      const v = ir.value as unknown;
      if (v instanceof Date) return {date: v.toISOString()};
      return v as ZcScalar;
    }
    case 'reference_expr':
      if (ir.contextName !== undefined) return {$ctx: ir.contextName};
      return {id: ir.value as string};
    case 'context_property_expr':
      return {$ctx: ir.contextName as string, path: labelOf(ir.property)};
    case 'property_expr': {
      const segs = refs.get(ir.sourceAlias);
      return {path: segs ? segmentsToPath(segs) : labelOf(ir.property)};
    }
    case 'alias_expr': {
      const segs = refs.get(ir.alias);
      // A bare alias_expr as a value is the node at the end of the traversal.
      return {path: segs ? segmentsToPath(segs) : ir.alias};
    }
    case 'binary_expr':
      return [
        ir.operator,
        encodeValueExpr(ir.left, refs),
        encodeValueExpr(ir.right, refs),
      ];
    case 'logical_expr':
      return [ir.operator, ...ir.expressions.map((e) => encodeValueExpr(e, refs))];
    case 'not_expr':
      return ['not', encodeValueExpr(ir.expression, refs)];
    case 'function_expr':
      return [ir.name, ...ir.args.map((a) => encodeValueExpr(a, refs))];
    case 'aggregate_expr':
      return [ir.name, ...ir.args.map((a) => encodeValueExpr(a, refs))];
    default:
      throw new Error(`Cannot encode expression of kind '${(ir as {kind: string}).kind}'`);
  }
}

/** Decode a Z-c value back into an IR expression + its placeholder refs. */
export function decodeValueExpr(
  zc: ZcValue,
  shape: NodeShape,
): {ir: IRExpression; refs: PropertyRefMap} {
  // S-expr array
  if (Array.isArray(zc)) {
    const [head, ...operands] = zc;
    const refs = new Map<string, readonly string[]>();
    const args = operands.map((o) => {
      const {ir, refs: r} = decodeValueExpr(o, shape);
      mergeRefs(refs, r);
      return ir;
    });
    return {ir: headToIR(head, args), refs};
  }
  // Objects: recognized value-objects
  if (zc !== null && typeof zc === 'object') {
    const o = zc as Record<string, unknown>;
    if ('id' in o) {
      return {ir: {kind: 'reference_expr', value: o.id as string}, refs: new Map()};
    }
    if ('$ctx' in o) {
      if (typeof o.path === 'string') {
        const property = pathToSegmentIds(shape, o.path).pop() as string;
        return {
          ir: {kind: 'context_property_expr', contextName: o.$ctx as string, property},
          refs: new Map(),
        };
      }
      return {ir: {kind: 'reference_expr', contextName: o.$ctx as string}, refs: new Map()};
    }
    if ('date' in o) {
      return {ir: {kind: 'literal_expr', value: new Date(o.date as string) as never}, refs: new Map()};
    }
    if ('path' in o) {
      return propertyOrAlias(shape, o.path as string);
    }
    if ('list' in o) {
      throw new Error('A {list} value is only valid as an in/nin operand');
    }
  }
  // bare scalar literal
  return {ir: {kind: 'literal_expr', value: zc as never}, refs: new Map()};
}

/**
 * Resolve a dotted path to its expression node:
 *  - empty path `""` → `alias_expr` (the bare subject, e.g. `p.equals(x)`);
 *  - any non-empty path → `property_expr` (a property access, relation or not —
 *    `p.bestFriend.equals(x)` compares the property value, no traversal).
 */
function propertyOrAlias(
  shape: NodeShape,
  path: string,
): {ir: IRExpression; refs: PropertyRefMap} {
  const node =
    path === ''
      ? tracedAliasExpression([])
      : tracedPropertyExpression(pathToSegmentIds(shape, path));
  return {ir: node.ir, refs: node._refs};
}

/** Build an IR node from an S-expr head symbol/name + decoded args. */
function headToIR(head: string, args: IRExpression[]): IRExpression {
  if (head === 'and' || head === 'or') {
    return {kind: 'logical_expr', operator: head, expressions: args};
  }
  if (head === 'not') {
    return {kind: 'not_expr', expression: args[0]};
  }
  if (COMPARISON_OPS.has(head as IRBinaryOperator) || '+-*/'.includes(head)) {
    return {kind: 'binary_expr', operator: head as IRBinaryOperator, left: args[0], right: args[1]};
  }
  if (AGGREGATES.has(head)) {
    return {kind: 'aggregate_expr', name: head as never, args};
  }
  // default: a named function (verbatim IR function name, e.g. STRLEN)
  return {kind: 'function_expr', name: head, args};
}

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

// ---------------------------------------------------------------------------
// CONDITION tier
// ---------------------------------------------------------------------------

/** Encode a where-clause node (boolean) into a Z-c condition. */
export function encodeCondition(
  node: ExpressionNode | ExistsCondition,
  shape: NodeShape,
): ZcCondition {
  if (node instanceof ExistsCondition) {
    return encodeExists(node, shape);
  }
  return encodeBoolExpr(node.ir, node._refs, shape);
}

function encodeExists(ec: ExistsCondition, shape: NodeShape): ZcCondition {
  const rel = segmentsToPath(ec.pathSegmentIds);
  let quantifier: 'some' | 'none' | 'every';
  let predIr = ec.predicate.ir;
  const predRefs = ec.predicate._refs;
  if (!ec.negated) {
    quantifier = 'some';
  } else if (predIr.kind === 'not_expr') {
    // every(fn) was built as NOT EXISTS(NOT fn) — unwrap the inner predicate.
    quantifier = 'every';
    predIr = predIr.expression;
  } else {
    quantifier = 'none';
  }
  let base: ZcCondition = {
    [`${rel}.${quantifier}`]: encodeBoolExpr(predIr, predRefs, shape),
  };
  // Fold any chained and/or conditions into nested logical combinators.
  for (const {op, condition} of ec.chain) {
    const c = encodeCondition(
      condition instanceof ExistsCondition ? condition : (condition as ExpressionNode),
      shape,
    );
    base = {[op]: [base, c]} as ZcCondition;
  }
  return base;
}

/** Encode a boolean IR expression into a Z-c condition (path-keyed where possible). */
function encodeBoolExpr(
  ir: IRExpression,
  refs: PropertyRefMap,
  shape: NodeShape,
): ZcCondition {
  if (ir.kind === 'logical_expr') {
    const parts = ir.expressions.map((e) => encodeBoolExpr(e, refs, shape));
    if (ir.operator === 'and') {
      const merged = tryMergeAnd(parts);
      if (merged) return merged;
    }
    return {[ir.operator]: parts} as ZcCondition;
  }
  if (ir.kind === 'not_expr') {
    return {not: encodeBoolExpr(ir.expression, refs, shape)};
  }
  if (ir.kind === 'binary_expr' && COMPARISON_OPS.has(ir.operator)) {
    const key = pathKeyOf(ir.left, refs);
    if (key !== null) {
      const value = encodeValueExpr(ir.right, refs);
      if (ir.operator === '=') return {[key]: value};
      return {[key]: {[ir.operator]: value}};
    }
  }
  // Fallback: S-expr (boolean expression that isn't a simple path-keyed shape).
  return encodeValueExpr(ir, refs) as ZcCondition;
}

/** A path key for a left operand that is a single property/alias/context property. */
function pathKeyOf(ir: IRExpression, refs: PropertyRefMap): string | null {
  if (ir.kind === 'property_expr') {
    const segs = refs.get(ir.sourceAlias);
    return segs ? segmentsToPath(segs) : labelOf(ir.property);
  }
  if (ir.kind === 'alias_expr') {
    const segs = refs.get(ir.alias);
    return segs ? segmentsToPath(segs) : null;
  }
  if (ir.kind === 'context_property_expr') {
    return null; // a context property on the LHS is uncommon; use S-expr
  }
  return null;
}

/** Merge AND conjuncts into one path-keyed object iff all are distinct single-key path conditions. */
function tryMergeAnd(parts: ZcCondition[]): ZcCondition | null {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    if (Array.isArray(p) || typeof p !== 'object' || p === null) return null;
    const keys = Object.keys(p);
    if (keys.length !== 1) return null;
    const k = keys[0];
    if (COMBINATORS.has(k) || k in out) return null;
    out[k] = (p as Record<string, unknown>)[k];
  }
  return out as ZcCondition;
}

/** Decode a Z-c condition into a runtime WherePath (`{expressionNode}` | `{existsCondition}`). */
export function decodeCondition(zc: ZcCondition, shape: NodeShape): WherePath {
  const node = decodeConditionNode(zc, shape);
  return node instanceof ExistsCondition
    ? ({existsCondition: node} as WherePath)
    : ({expressionNode: node} as WherePath);
}

function decodeConditionNode(
  zc: ZcCondition,
  shape: NodeShape,
): ExpressionNode | ExistsCondition {
  // S-expr fallback
  if (Array.isArray(zc)) {
    const {ir, refs} = decodeValueExpr(zc, shape);
    return new ExpressionNode(ir, refs);
  }
  const o = zc as Record<string, unknown>;
  const keys = Object.keys(o);

  // Combinators
  if (keys.length === 1 && COMBINATORS.has(keys[0])) {
    const k = keys[0];
    if (k === 'not') {
      const inner = decodeConditionNode(o.not as ZcCondition, shape);
      if (inner instanceof ExistsCondition) return inner.not();
      return new ExpressionNode({kind: 'not_expr', expression: inner.ir}, inner._refs);
    }
    // and / or
    const elems = (o[k] as ZcCondition[]).map((c) => decodeConditionNode(c, shape));
    // An exists-chain: first operand is an ExistsCondition → fold the rest as its chain.
    if (elems[0] instanceof ExistsCondition) {
      let ec = elems[0] as ExistsCondition;
      for (let i = 1; i < elems.length; i++) {
        ec = (k === 'and' ? ec.and(elems[i] as never) : ec.or(elems[i] as never)) as ExistsCondition;
      }
      return ec;
    }
    const refs = new Map<string, readonly string[]>();
    const expressions = elems.map((e) => {
      mergeRefs(refs, (e as ExpressionNode)._refs);
      return (e as ExpressionNode).ir;
    });
    return new ExpressionNode({kind: 'logical_expr', operator: k as 'and' | 'or', expressions}, refs);
  }

  // Single quantifier key: "rel.some" | "rel.every" | "rel.none"
  if (keys.length === 1) {
    const q = matchQuantifier(keys[0]);
    if (q) {
      const predicate = expressionNodeFromCondition(o[keys[0]] as ZcCondition, shape);
      const segmentIds = pathToSegmentIds(shape, q.rel);
      if (q.kind === 'some') return new ExistsCondition(segmentIds, predicate, false);
      if (q.kind === 'none') return new ExistsCondition(segmentIds, predicate, true);
      // every(fn) = NOT EXISTS(NOT fn)
      return new ExistsCondition(
        segmentIds,
        new ExpressionNode({kind: 'not_expr', expression: predicate.ir}, predicate._refs),
        true,
      );
    }
  }

  // Path-keyed condition(s): one or more `path: value|opMap` → AND of comparisons.
  const refs = new Map<string, readonly string[]>();
  const comparisons: IRExpression[] = [];
  for (const key of keys) {
    const left = propertyOrAlias(shape, key);
    mergeRefs(refs, left.refs);
    const v = o[key];
    for (const cmp of comparisonsFor(left.ir, v, shape, refs)) comparisons.push(cmp);
  }
  const ir =
    comparisons.length === 1
      ? comparisons[0]
      : {kind: 'logical_expr' as const, operator: 'and' as const, expressions: comparisons};
  return new ExpressionNode(ir, refs);
}

function comparisonsFor(
  left: IRExpression,
  value: unknown,
  shape: NodeShape,
  refs: Map<string, readonly string[]>,
): IRExpression[] {
  // operator map: { ">": 18, "<": 65 }
  if (isOpMap(value)) {
    return Object.entries(value as ZcOpMap).map(([op, v]) => {
      const r = decodeValueExpr(v as ZcValue, shape);
      mergeRefs(refs, r.refs);
      return {kind: 'binary_expr', operator: op as IRBinaryOperator, left, right: r.ir};
    });
  }
  // implicit equals
  const r = decodeValueExpr(value as ZcValue, shape);
  mergeRefs(refs, r.refs);
  return [{kind: 'binary_expr', operator: '=', left, right: r.ir}];
}

/** An object whose keys are all operator symbols (not a recognized value-object). */
function isOpMap(value: unknown): boolean {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value as object);
  if (keys.length === 0) return false;
  if (keys.some((k) => k === 'id' || k === '$ctx' || k === 'path' || k === 'date' || k === 'list')) {
    return false;
  }
  // Only comparison operators form an op-map. `in`/`nin` are intentionally NOT
  // recognized here: there is no matching IR operator or encoder path yet, so
  // accepting them would only produce a broken decode (backlog 002, G7).
  return keys.every((k) => COMPARISON_OPS.has(k as IRBinaryOperator));
}

function matchQuantifier(
  key: string,
): {rel: string; kind: 'some' | 'every' | 'none'} | null {
  for (const kind of ['some', 'every', 'none'] as const) {
    if (key.endsWith(`.${kind}`)) {
      return {rel: key.slice(0, -(kind.length + 1)), kind};
    }
  }
  return null;
}

/** A quantifier predicate decodes to an ExpressionNode (its inner boolean). */
function expressionNodeFromCondition(zc: ZcCondition, shape: NodeShape): ExpressionNode {
  const node = decodeConditionNode(zc, shape);
  if (node instanceof ExistsCondition) {
    // Nested exists as a predicate is uncommon; wrap is not representable here.
    throw new Error('Nested exists inside a quantifier predicate is not supported');
  }
  return node;
}
