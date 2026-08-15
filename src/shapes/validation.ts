/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * SHACL-aligned validation of plain data objects against a node shape.
 *
 * One entry point — {@link validate} — used by the create and update pipelines
 * (via `MutationQueryFactory.describe()`) and directly by callers that want to
 * know how well an object fits a shape without building a mutation.
 *
 * **Shape of the output.** This library has no triple/Turtle layer and this
 * module does not add one: a {@link ValidationReport} is plain JavaScript. It is
 * however 1-1 with the SHACL vocabulary — one key per SHACL property, named
 * after it, holding a value the mutation pipeline accepts (a literal, or a
 * `{id}` node reference for IRI-valued properties). So a report can be
 * materialized by an ordinary create query as soon as shape classes for
 * `sh:ValidationReport` / `sh:ValidationResult` exist, with no transform step:
 *
 * ```ts
 * const report = validate(Slide, data);
 * await ValidationReport.create(report);   // once those shape classes exist
 * ```
 *
 * Two deliberate departures, both documented on the types: `results` is plural
 * where SHACL's repeated property is `sh:result`, and `propertyPath` is a
 * non-SHACL locator. Both map cleanly — a shape class chooses its own labels for
 * SHACL paths, and an extension property is legal on a SHACL report.
 *
 * **Coverage.** Structural constraints only — cardinality (`sh:minCount` /
 * `sh:maxCount`), node kind (literal vs relation), and undeclared properties.
 * Datatype, pattern, length and value-range constraints are parsed and
 * serialized (see report 024, G5) but deliberately not enforced here; the store
 * validates those. Adding one is a single entry in {@link PROPERTY_CONSTRAINTS}.
 */
import {shacl} from '../ontologies/shacl.js';
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {getUniquePropertyShapes} from './nodeShapeData.js';
import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import {isExpressionNode} from '../expressions/ExpressionNode.js';
import {asContextRef} from '../queries/QueryContext.js';

/**
 * Which constraints apply to the data being validated.
 *
 * - `complete` — the object describes a whole node (a create, or a standalone
 *   object being checked for fit). Properties absent from the data are genuinely
 *   absent, so `sh:minCount` presence is checkable.
 * - `partial` — the object describes a change to an existing node (an update).
 *   The store holds whatever the payload does not mention, so presence is
 *   unknowable; only the values actually provided are checked.
 */
export type ValidationMode = 'complete' | 'partial';

/**
 * A single constraint violation — an `sh:ValidationResult`.
 *
 * Every key is the local name of the SHACL property it carries, and every value
 * is in a form the create pipeline accepts (a literal, or a `{id}` node
 * reference for IRI-valued properties). A shape class declaring these
 * properties therefore materializes a result with no transform step:
 * `ValidationResult.create(result)`. The one non-SHACL key is `propertyPath`;
 * see {@link ValidationReport}.
 */
export interface ValidationResult {
  /** `sh:focusNode` — the node the violation is about, when its id is known. */
  focusNode?: NodeReferenceValue;
  /** `sh:resultPath` — the IRI of the property the violation is about. */
  resultPath?: NodeReferenceValue;
  /**
   * `sh:value` — the offending value, present only when it is an RDF term (a
   * literal or a node reference). Cardinality violations are about the property
   * rather than any one value, so they carry none.
   */
  value?: LiteralTerm | NodeReferenceValue;
  /** `sh:sourceShape` — the node or property shape carrying the constraint. */
  sourceShape?: NodeReferenceValue;
  /** `sh:sourceConstraintComponent` — which SHACL constraint failed. */
  sourceConstraintComponent: NodeReferenceValue;
  /** `sh:resultSeverity` — `sh:Violation`, `sh:Warning` or `sh:Info`. */
  resultSeverity: NodeReferenceValue;
  /** `sh:resultMessage` — human-readable explanation. */
  resultMessage: string;
  /**
   * **Not SHACL.** The property's label, dot-joined through nested shapes
   * (`author.fullName`) — the locator a caller needs to point at a field in the
   * object they passed in, which `sh:resultPath` alone cannot give (it names the
   * property, not where the nesting reached it). Materializes like any other
   * property once a shape class declares it; drop it for a pure-SHACL result.
   */
  propertyPath?: string;
}

/**
 * The outcome of a validation run — an `sh:ValidationReport`.
 *
 * Plain objects, 1-1 with the SHACL vocabulary, so a report can later be
 * materialized through an ordinary create query against shape classes for
 * `sh:ValidationReport` / `sh:ValidationResult` — whether or not this library
 * ever ships those classes. `results` is the sole plural rename (SHACL's
 * property is `sh:result`, repeated); a shape class maps it with
 * `@objectProperty({path: shacl.result, …}) get results()`.
 */
export interface ValidationReport {
  /** `sh:conforms` — true when there are no `sh:Violation`-severity results. */
  conforms: boolean;
  /** `sh:result` — every violation found, in deterministic order. */
  results: ValidationResult[];
}

/** The literal types the mutation pipeline accepts as a value. */
type LiteralTerm = string | number | boolean | Date;

export interface ValidateOptions {
  /** Defaults to `complete`. */
  mode?: ValidationMode;
  /** How deep to descend into nested node descriptions. Defaults to 10. */
  maxDepth?: number;
}

/** Thrown by {@link assertValid} — carries the full report, not just the first violation. */
export class ShapeValidationError extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(report.results.map((r) => r.resultMessage).join('\n'));
    this.name = 'ShapeValidationError';
    this.report = report;
  }
}

/**
 * Keys that carry metadata about the node rather than a property value: `id` /
 * `__id` name it, and `shape` names the shape of a nested value when the
 * property shape itself doesn't declare one (see `convertUpdateValue`).
 */
const RESERVED_KEYS = new Set(['id', '__id', 'shape']);

/**
 * The message for an undeclared property key. Shared with the normalization path
 * in `MutationQuery`, which needs the same guard to build a field at all.
 */
export function undeclaredPropertyMessage(key: string, shape: NodeShapeData): string {
  const shapeName = shape.label || shape.id?.split('/').pop();
  return (
    `Invalid property key: ${key}. The shape ${shapeName} does not have a registered ` +
    `property with this name. Make sure the get/set method exists, and that it uses a ` +
    `@objectProperty or @literalProperty decorator.`
  );
}

// ---------------------------------------------------------------------------
// Constraint components
// ---------------------------------------------------------------------------

/** What a constraint check needs to know about the property it is checking. */
interface PropertyContext {
  shape: NodeShapeData;
  propertyShape: PropertyShapeData;
  /** Dot-joined label path from the root of the validated object. */
  property: string;
  focusNode?: string;
  mode: ValidationMode;
}

/**
 * A constraint check. Receives the property's values already normalized to an
 * array (a single value becomes a one-element array) and returns any violations.
 */
type ConstraintCheck = (values: unknown[], ctx: PropertyContext) => ValidationResult[];

/**
 * `sh:value` must be an RDF term. A literal or a node reference is one; a plain
 * object, array or function is not, so it is left off rather than emitted as
 * something no store could materialize — the message still names it.
 */
function asTerm(value: unknown): LiteralTerm | NodeReferenceValue | undefined {
  if (isScalarValue(value)) return value as LiteralTerm;
  if (isNodeReference(value)) return {id: (value as NodeReferenceValue).id};
  return undefined;
}

/**
 * A violation about the node itself rather than one of its property shapes —
 * `sh:sourceShape` is the node shape, and there is no `sh:resultPath` (an
 * undeclared key has no property IRI to point at).
 */
function nodeViolation(
  shape: NodeShapeData,
  ctx: {focusNode?: string},
  component: NodeReferenceValue,
  message: string,
  propertyPath?: string,
  value?: unknown,
): ValidationResult {
  const result: ValidationResult = {
    sourceConstraintComponent: component,
    resultSeverity: shacl.Violation,
    resultMessage: message,
  };
  if (ctx.focusNode) result.focusNode = {id: ctx.focusNode};
  if (propertyPath) result.propertyPath = propertyPath;
  const term = asTerm(value);
  if (term !== undefined) result.value = term;
  if (shape.id) result.sourceShape = {id: shape.id};
  return result;
}

/**
 * Build a result, omitting absent keys entirely — an `undefined` value is not a
 * property the create pipeline should see.
 */
function violation(
  ctx: PropertyContext,
  component: NodeReferenceValue,
  message: string,
  value?: unknown,
): ValidationResult {
  const result: ValidationResult = {
    sourceConstraintComponent: component,
    resultSeverity: shacl.Violation,
    resultMessage: message,
  };
  if (ctx.focusNode) result.focusNode = {id: ctx.focusNode};
  const path = ctx.propertyShape.path as NodeReferenceValue | undefined;
  if (path?.id) result.resultPath = {id: path.id};
  if (ctx.property) result.propertyPath = ctx.property;
  const term = asTerm(value);
  if (term !== undefined) result.value = term;
  const sourceShape = ctx.propertyShape.id || ctx.shape.id;
  if (sourceShape) result.sourceShape = {id: sourceShape};
  return result;
}

/** The label used in messages — the property's own label, not its nested path. */
function labelOf(ps: PropertyShapeData): string {
  return ps.label || ps.id;
}

/** `sh:maxCount` — no more values than the shape allows. */
const maxCountCheck: ConstraintCheck = (values, ctx) => {
  const {maxCount} = ctx.propertyShape;
  if (typeof maxCount !== 'number' || values.length <= maxCount) return [];
  return [
    violation(
      ctx,
      shacl.MaxCountConstraintComponent,
      `Property '${labelOf(ctx.propertyShape)}' allows at most ${maxCount} value(s), but ${values.length} were provided.`,
    ),
  ];
};

/** `sh:minCount` — at least as many values as the shape requires. */
const minCountCheck: ConstraintCheck = (values, ctx) => {
  const {minCount} = ctx.propertyShape;
  if (typeof minCount !== 'number' || minCount <= 0 || values.length >= minCount) return [];
  return [
    violation(
      ctx,
      shacl.MinCountConstraintComponent,
      `Property '${labelOf(ctx.propertyShape)}' requires at least ${minCount} value(s), but ${values.length} were provided.`,
    ),
  ];
};

/** True when the property clearly accepts only literal values. */
function expectsLiteral(ps: PropertyShapeData): boolean {
  if (ps.nodeKind) return ps.nodeKind.id === shacl.Literal.id;
  return !!ps.datatype && !ps.valueShape;
}

/** True when the property clearly accepts only nodes (IRIs/blank nodes). */
function expectsNode(ps: PropertyShapeData): boolean {
  if (ps.nodeKind) {
    return (
      ps.nodeKind.id === shacl.IRI.id ||
      ps.nodeKind.id === shacl.BlankNode.id ||
      ps.nodeKind.id === shacl.BlankNodeOrIRI.id
    );
  }
  return !!ps.valueShape;
}

function isScalarValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/**
 * `sh:nodeKind` — literal properties reject nodes/objects, relation properties
 * reject bare scalars. Ambiguous kinds (`sh:IRIOrLiteral`, or no `nodeKind` and
 * no `datatype`/`valueShape` to infer from) are not enforced.
 */
const nodeKindCheck: ConstraintCheck = (values, ctx) => {
  const ps = ctx.propertyShape;
  const literalExpected = expectsLiteral(ps);
  const nodeExpected = expectsNode(ps);
  if (!literalExpected && !nodeExpected) return [];

  const results: ValidationResult[] = [];
  for (const el of values) {
    if (el === null || el === undefined || isExpressionNode(el) || asContextRef(el)) continue;
    const scalar = isScalarValue(el);
    if (literalExpected && !scalar) {
      results.push(
        violation(
          ctx,
          shacl.NodeKindConstraintComponent,
          `Property '${labelOf(ps)}' is a literal property but was given a ${typeof el === 'object' ? 'node/object' : typeof el} value.`,
          el,
        ),
      );
    } else if (nodeExpected && scalar) {
      results.push(
        violation(
          ctx,
          shacl.NodeKindConstraintComponent,
          `Property '${labelOf(ps)}' is a relation (object) property but was given a literal (${typeof el}). Provide a {id} reference or a nested object.`,
          el,
        ),
      );
    }
  }
  return results;
};

/**
 * The registry. Every property-level constraint the library enforces lives here;
 * adding `sh:pattern` or `sh:datatype` enforcement is one more entry (see the
 * deferred items in `docs/plans/001-shape-validation-report.md`).
 */
const PROPERTY_CONSTRAINTS: ConstraintCheck[] = [maxCountCheck, minCountCheck, nodeKindCheck];

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/**
 * A `{add, remove}` set modification. The resulting value count depends on the
 * node's current state, so cardinality and kind are unknowable here.
 */
function isSetModification(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const expected = (obj.add ? 1 : 0) + (obj.remove ? 1 : 0);
  return expected > 0 && Object.getOwnPropertyNames(obj).length === expected;
}

/** An object carrying only an `id` — a reference to an existing node, not a description. */
function isNodeReference(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    Object.keys(value).length === 1
  );
}

/** Values whose final shape isn't knowable without the store or a lowering pass. */
function isOpaqueValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === 'function' ||
    isExpressionNode(value) ||
    !!asContextRef(value) ||
    isSetModification(value)
  );
}

/** A nested node description — an object to descend into, rather than a leaf value. */
function isNodeDescription(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isNodeReference(value) &&
    !isOpaqueValue(value)
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Accepts a shape class (`Person`) or the plain `NodeShapeData` it carries. */
export type ValidatableShape = NodeShapeData | {shape: NodeShapeData};

function resolveShapeData(shape: ValidatableShape): NodeShapeData {
  const resolved = 'propertyShapes' in shape ? shape : (shape as {shape: NodeShapeData}).shape;
  if (!resolved) {
    throw new Error(
      'validate() requires a node shape or a shape class with a static `shape`. ' +
        'Did you pass an unregistered class (missing @linkedShape)?',
    );
  }
  return resolved as NodeShapeData;
}

/**
 * Validate a plain data object against a node shape.
 *
 * Never throws for invalid *data* — a violation is a result, not an exception.
 * (It does throw when the *shape* argument itself is unusable.)
 *
 * ```ts
 * const report = validate(Person, {name: ['a', 'b']});
 * report.conforms; // false
 * report.results[0].sourceConstraintComponent.id; // …shacl#MaxCountConstraintComponent
 * ```
 */
export function validate(
  shape: ValidatableShape,
  data: unknown,
  options: ValidateOptions = {},
): ValidationReport {
  const {mode = 'complete', maxDepth = 10} = options;
  const results = validateNode(resolveShapeData(shape), data, {
    mode,
    maxDepth,
    depth: 0,
    prefix: '',
  });
  return {
    conforms: !results.some((r) => r.resultSeverity.id === shacl.Violation.id),
    results,
  };
}

/** {@link validate}, but throws a {@link ShapeValidationError} when the data doesn't conform. */
export function assertValid(
  shape: ValidatableShape,
  data: unknown,
  options: ValidateOptions = {},
): void {
  const report = validate(shape, data, options);
  if (!report.conforms) throw new ShapeValidationError(report);
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface WalkContext {
  mode: ValidationMode;
  maxDepth: number;
  depth: number;
  /** Dot-joined label path of the node being validated (`''` at the root). */
  prefix: string;
  focusNode?: string;
}

function validateNode(
  shape: NodeShapeData,
  data: unknown,
  ctx: WalkContext,
): ValidationResult[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [
      nodeViolation(
        shape,
        ctx,
        shacl.NodeConstraintComponent,
        `Expected an object describing '${shape.label || shape.id}', but got ${data === null ? 'null' : typeof data}.`,
        ctx.prefix,
        data,
      ),
    ];
  }

  const obj = data as Record<string, unknown>;
  const propertyShapes = getUniquePropertyShapes(shape);
  const byLabel = new Map(propertyShapes.map((ps) => [ps.label, ps]));
  const focusNode =
    typeof obj.__id === 'string'
      ? obj.__id
      : typeof obj.id === 'string'
        ? obj.id
        : ctx.focusNode;
  const results: ValidationResult[] = [];

  // Presence of required properties — only decidable for a complete description.
  if (ctx.mode === 'complete') {
    for (const ps of propertyShapes) {
      if (typeof ps.minCount !== 'number' || ps.minCount <= 0) continue;
      if (ps.label in obj) continue;
      results.push(
        violation(
          {shape, propertyShape: ps, property: join(ctx.prefix, ps.label), focusNode, mode: ctx.mode},
          shacl.MinCountConstraintComponent,
          `Property '${labelOf(ps)}' requires at least ${ps.minCount} value(s), but none were provided.`,
        ),
      );
    }
  }

  // The values actually provided.
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const propertyShape = byLabel.get(key);
    if (!propertyShape) {
      results.push(
        nodeViolation(
          shape,
          {...ctx, focusNode},
          shacl.ClosedConstraintComponent,
          undeclaredPropertyMessage(key, shape),
          join(ctx.prefix, key),
          value,
        ),
      );
      continue;
    }
    results.push(
      ...validateProperty(value, {
        shape,
        propertyShape,
        property: join(ctx.prefix, key),
        focusNode,
        mode: ctx.mode,
      }, ctx),
    );
  }

  return results;
}

function validateProperty(
  value: unknown,
  propCtx: PropertyContext,
  walk: WalkContext,
): ValidationResult[] {
  const ps = propCtx.propertyShape;

  // `null` clears the property — the same as providing zero values, so clearing
  // a required one is a cardinality violation (both spellings behave alike).
  if (value === null) {
    if (typeof ps.minCount === 'number' && ps.minCount > 0) {
      return [
        violation(
          propCtx,
          shacl.MinCountConstraintComponent,
          `Property '${labelOf(ps)}' requires at least ${ps.minCount} value(s) and cannot be cleared.`,
        ),
      ];
    }
    return [];
  }

  if (isOpaqueValue(value)) return [];

  const values = Array.isArray(value) ? value : [value];
  const results: ValidationResult[] = [];
  for (const check of PROPERTY_CONSTRAINTS) {
    results.push(...check(values, propCtx));
  }

  // Descend into nested node descriptions (`sh:node`-style recursion). A bare
  // `{id}` is a reference to an existing node and has nothing to validate; an
  // object with an id *and* data is a nested create with a predefined id.
  if (walk.depth < walk.maxDepth) {
    for (const el of values) {
      if (!isNodeDescription(el)) continue;
      const nestedShape = resolveValueShape(ps, el);
      if (!nestedShape) continue;
      results.push(
        ...validateNode(nestedShape, el, {
          ...walk,
          depth: walk.depth + 1,
          prefix: propCtx.property,
          focusNode: undefined,
        }),
      );
    }
  }

  return results;
}

/**
 * The shape a nested value should be validated against: the property's declared
 * `valueShape`, or — for properties that declare none — the shape class carried
 * in the value's reserved `shape` key. Mirrors `convertUpdateValue`; returns
 * undefined when neither is available (normalization reports that itself).
 */
function resolveValueShape(
  ps: PropertyShapeData,
  value: unknown,
): NodeShapeData | undefined {
  if (ps.valueShape) return getShapeClass(ps.valueShape)?.shape;
  const declared = (value as {shape?: {shape?: NodeShapeData}}).shape;
  return declared?.shape;
}

function join(prefix: string, label: string): string {
  return prefix ? `${prefix}.${label}` : label;
}
