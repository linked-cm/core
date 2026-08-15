---
summary: Restructure write-validation into a single SHACL-aligned validator — one `validate(shape, data)` entry point returning a `ValidationReport` (`conforms` + `results`), reused by create, update, and standalone callers, replacing the split between `toJSON()` (value checks) and `lower()` (required-field checks).
packages: [core]
---

# 001 — Shape validation report

## Problem

Write-validation is split across three sites with two different trigger points:

| Site | Checks | Runs at |
| --- | --- | --- |
| `MutationQuery.validateAgainstShape` (`src/queries/MutationQuery.ts:206`) | cardinality, literal-vs-relation node kind | `toJSON()`, `lower()`, `exec()` |
| `MutationQuery.convertNodeDescription` (`:164`) | unknown property key | `toJSON()`, `lower()`, `exec()` |
| `CreateBuilder._lowerSpec` (`src/queries/CreateBuilder.ts:115`) | required fields present | `lower()`, `exec()` — **not** `toJSON()` |

Consequences:

1. **Asymmetric behaviour.** `create(data).toJSON()` accepts data that `lower(create(data))` rejects. Nothing about serialization versus lowering justifies the difference — it is an artifact of where the code happened to land.
2. **No standalone entry point.** Validating a plain object against a shape requires constructing a builder and calling `toJSON()` or `lower()` — methods whose purpose is serialization and IR-lowering, not validation.
3. **Fail-fast only.** The first violation throws, so a caller cannot ask "how well does this object fit the shape?" — the question a document-extraction pipeline actually has.
4. **No structured output.** Violations are `Error` strings. There is no machine-readable path, constraint, or severity, even though `PropertyShapeData` carries the full SHACL constraint set and `src/ontologies/shacl.ts:72-88` already exports the `sh:ValidationReport` / `sh:ValidationResult` vocabulary.

## Approach

One validator, one report type, one gate.

**Create and update do not differ in where validation runs — only in which constraints apply.** Create is complete-node (properties absent from the data are genuinely absent, so `minCount` presence is checkable). Update is partial (the store holds values not mentioned in the payload, so presence is unknowable). That is a `mode` flag on one validator, not two call sites.

### Public API

```ts
// src/shapes/validation.ts
export type ValidationMode = 'complete' | 'partial';

export interface ValidationResult {
  focusNode?: NodeReferenceValue;                 // sh:focusNode
  resultPath?: NodeReferenceValue;                // sh:resultPath
  value?: LiteralTerm | NodeReferenceValue;       // sh:value — RDF terms only
  sourceShape?: NodeReferenceValue;               // sh:sourceShape
  sourceConstraintComponent: NodeReferenceValue;  // sh:sourceConstraintComponent
  resultSeverity: NodeReferenceValue;             // sh:resultSeverity
  resultMessage: string;                          // sh:resultMessage
  propertyPath?: string;                          // extension: dotted label path
}

export interface ValidationReport {
  conforms: boolean;                              // sh:conforms
  results: ValidationResult[];                    // sh:result
}

export function validate(
  shape: NodeShapeData | ShapeConstructor,
  data: unknown,
  options?: {mode?: ValidationMode; maxDepth?: number},
): ValidationReport;

export function assertValid(shape, data, options?): void;  // throws ShapeValidationError
export class ShapeValidationError extends Error { readonly report: ValidationReport }
```

### No RDF in this library — but a materializable report

`@_linked/core` has no triple, quad, or Turtle layer, and this plan does not add one. A report is
plain JavaScript. The requirement is stronger than "SHACL-flavoured naming": the object must be 1-1
with the vocabulary, so it can be **materialized by an ordinary create query** against shape classes
for `sh:ValidationReport` / `sh:ValidationResult` — `ValidationReport.create(report)` — whether or
not this library ever ships those classes.

That imposes three rules on the walk:

- one key per SHACL property, named after it;
- every value in a form the mutation pipeline accepts — a literal, or a `{id}` node reference for
  IRI-valued properties (so `focusNode` and `sourceShape` are refs, not bare strings);
- absent keys omitted entirely, and `sh:value` present only when the offending value is an RDF term
  (cardinality violations carry none — they are about the property, not a value).

Two departures, both documented on the types: `results` is plural where SHACL's repeated property is
`sh:result` (a shape class picks its own label for a path), and `propertyPath` is a non-SHACL
extension carrying the dotted label path, which `sh:resultPath` cannot express — it names the
property, not where the nesting reached it.

### Internal structure — constraint components

Each SHACL constraint is a self-contained function registered against the component IRI it reports:

```ts
type ConstraintCheck = (values: unknown[], ctx: PropertyContext) => ValidationResult[];
```

Adding `sh:pattern` enforcement later is one registry entry plus one test, not surgery on a 60-line method. Only the components the library enforces today are registered in this plan; the rest are listed under Deferred.

### Wiring

`MutationQueryFactory.describe()` gains an explicit options object and becomes the single gate — it already receives the post-callback resolved object, so the function form of `.set()` is covered without a second code path. `validateAgainstShape`, `expectsLiteral`, `expectsNode`, and the inline required-fields block in `CreateBuilder._lowerSpec` are deleted. All four `describe()` call sites (`CreateBuilder.ts:151`, `UpdateBuilder.ts:211`, `lower.ts:100`, `lower.ts:108`) pass their mode, so `toJSON()`, `lower()`, and `exec()` become identical in what they reject.

`MutationQueryFactory` is stateless — nothing extends it, and all four call sites construct it fresh — so the extraction is mechanical.

## Phases

1. **`src/shapes/validation.ts`** — types, `validate`, `assertValid`, `ShapeValidationError`, the component registry, and the four components enforced today: `MinCount`, `MaxCount`, `NodeKind`, `Closed` (unknown key). Messages carried over verbatim from the current implementation.
2. **Rewire** — `describe()` takes `{allowTopLevelId, mode}` and calls `assertValid`; per-value and required-field checks deleted from `MutationQuery` and `CreateBuilder`. Fixes the `toJSON()`/`lower()` asymmetry.
3. **Nested recursion** — descend through `valueShape` into nested node descriptions with a depth cap, producing dotted property paths and per-node `focusNode`. Closes the "nested required fields unchecked" gap.
4. **Export + docs + changeset.**

## Deferred

- **Datatype, pattern, length, and value-range components.** The metadata is parsed and serialized but never enforced (report 024, G5) — the store validates. Registering them is mechanical once phase 1 lands. **Open decision:** whether a coercible mismatch (`"42"` into an `xsd:integer` — the common case when data comes from document extraction) is a `sh:Violation` or a `sh:Warning`. Recommend `Warning`, so a report stays actionable without failing the whole node.
- **`sh:closed` as opt-in.** Today the unknown-key check is unconditional; SHACL makes it per-shape via `sh:closed` + `sh:ignoredProperties`, both already on `NodeShapeData`. Phase 1 keeps the current unconditional behaviour and reports it as `sh:ClosedConstraintComponent`. **Open decision:** whether to honour the flag and stop rejecting unknown keys on non-closed shapes — a behaviour change for anyone relying on the typo guard.
- **Validating query results.** The same engine can validate nodes read back from the store, not just write payloads. Out of scope here.

## Compatibility

`create(data).toJSON()` starts throwing on missing required fields. That is the point of the change, but it is a behaviour change: a minor version with a changeset. Violation messages are carried over verbatim, so the existing `mutation-shape-validation` assertions (which match on message substrings) continue to hold. `ShapeValidationError.message` joins all violation messages, so substring matches on any single violation still match.
