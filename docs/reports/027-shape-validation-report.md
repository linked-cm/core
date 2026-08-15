---
summary: Implemented the plan in docs/plans/001 — one SHACL-aligned validator (`validate` / `assertValid` returning a `ValidationReport`) behind create, update, and standalone callers, replacing the split where `toJSON()` checked values and `lower()` checked required fields.
source_plan: docs/plans/001-shape-validation-report.md
packages: [core]
---

# 027 — Shape validation report

Status: **done**. Phases 1-3 of the plan implemented; phase 4 items remain deferred as planned.
Suite: **1508 passed / 117 skipped**, typecheck green (baseline before this change: 1472 passed).

## What changed

**New module `src/shapes/validation.ts`.** `validate(shape, data, {mode, maxDepth})` returns a
`ValidationReport` — `conforms` plus a `results` array whose entries mirror `sh:ValidationResult`
(`focusNode`, `path`, `property`, `value`, `sourceShape`, `sourceConstraintComponent`, `severity`,
`message`). `assertValid()` is the throwing form; `ShapeValidationError.report` carries the full
report, and its `message` joins every violation rather than surfacing only the first.

Vocabulary-valued fields hold `NodeReferenceValue` refs from `ontologies/shacl` rather than strings.
The library still has no triple layer and this change does not add one — the point is that a consumer
which *does* have one maps a result to a `sh:ValidationResult` node field-by-field, with no semantics
to re-derive. Six terms were added to the ontology to make that possible: `MinCountConstraintComponent`,
`MaxCountConstraintComponent`, `NodeKindConstraintComponent`, `ClosedConstraintComponent`, `Warning`,
`Info`.

**Constraints are a registry.** Each check is a `(values, ctx) => ValidationResult[]` function in
`PROPERTY_CONSTRAINTS`. The four the library enforces — `sh:maxCount`, `sh:minCount`, `sh:nodeKind`,
and undeclared properties (reported as `sh:ClosedConstraintComponent`) — are entries in it. Adding
`sh:pattern` or `sh:datatype` enforcement later is one entry and one test.

**One gate instead of two.** `MutationQueryFactory.describe()` takes an options object
(`{allowTopLevelId, validate}`) and validates the resolved data before normalizing. The four call
sites — `CreateBuilder.toJSON`, `UpdateBuilder.toJSON`, and both `lower()` paths — pass their mode,
so `toJSON()`, `lower()` and `exec()` reject identically. Deleted: `validateAgainstShape`,
`expectsLiteral`, `expectsNode` (`MutationQuery`), the inline required-fields block and its stale
`TODO` (`CreateBuilder._lowerSpec`). The undeclared-property guard stays in `convertNodeDescription`
— normalization cannot build a field without a property shape — but shares its message with the
validator via `undeclaredPropertyMessage()` rather than duplicating the string.

**Mode, not call site.** Create and update differ only in whether absent properties are decidable:
`complete` (create, and standalone checks) verifies `minCount` presence; `partial` (update) checks
only provided values, since the store holds the rest. Nested descriptions inherit the parent's mode.

## Deviations from the plan

- **`shape` is a reserved key.** The plan's key iteration missed that nested node data may carry
  `shape` to name the value's shape when the property shape doesn't declare one (`rdfList`, and
  `syncShapes` through it). Eleven tests caught this. `shape` joins `id`/`__id` as reserved, and
  nested-shape resolution now mirrors `convertUpdateValue`: `valueShape` first, then the value's own
  `shape` key.
- **Nested recursion (phase 3) shipped with phases 1-2** rather than separately — the walk needed it
  to produce dotted property paths, and separating it would have meant writing the recursion twice.

## Behaviour changes

1. `create(data).toJSON()` now throws when a required property is missing. This is the asymmetry the
   plan set out to fix, but it is a real change for anyone who used `toJSON()` as a lenient
   serializer. Minor version, changeset written.
2. Required properties of *nested* creates are now checked. Previously unchecked at any level.
3. A failing mutation reports every violation, not the first. Message text for individual violations
   is carried over verbatim; the aggregated `Missing required fields for 'X': a, b` string is gone,
   replaced by one `sh:minCount` result per property.

One existing test changed: `mutation-shape-validation` → "an ambiguous node-kind property skips the
kind check" built a `Team` without its required `members`, which now fails for an unrelated reason.
It supplies `members` and still asserts exactly what its name says.

## Still deferred

Unchanged from the plan, and both still open decisions:

- **Datatype, pattern, length, value-range components.** Metadata is parsed and serialized (report
  024, G5) but not enforced; the store validates. Open: whether a coercible mismatch (`"42"` into an
  `xsd:integer` — the common case for data extracted from documents) should be `sh:Warning` rather
  than `sh:Violation`. Recommend `Warning`.
- **`sh:closed` as opt-in.** The undeclared-property check is unconditional, as before; SHACL makes it
  per-shape via `sh:closed` + `sh:ignoredProperties`, both already on `NodeShapeData`. Honouring the
  flag would stop rejecting unknown keys on non-closed shapes — a behaviour change, so it stays
  behind this decision.
- **Validating nodes read back from the store**, not just write payloads. The engine is shape-driven
  and would need only a different input adapter.
