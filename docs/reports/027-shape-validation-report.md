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

### The report is 1-1 with the SHACL vocabulary

The library has no triple layer and this change does not add one. What it guarantees instead is that
a report is *materializable as-is*: one key per SHACL property, named after it, holding a value the
mutation pipeline accepts. Given shape classes for `sh:ValidationReport` / `sh:ValidationResult`,
`ValidationReport.create(report)` works with no transform step.

| Report key | SHACL property | Value form |
| --- | --- | --- |
| `conforms` | `sh:conforms` | boolean literal |
| `results` | `sh:result` | nested node descriptions |
| `focusNode` | `sh:focusNode` | `{id}` |
| `resultPath` | `sh:resultPath` | `{id}` |
| `value` | `sh:value` | literal or `{id}` |
| `sourceShape` | `sh:sourceShape` | `{id}` |
| `sourceConstraintComponent` | `sh:sourceConstraintComponent` | `{id}` |
| `resultSeverity` | `sh:resultSeverity` | `{id}` |
| `resultMessage` | `sh:resultMessage` | string literal |
| `propertyPath` | — (extension) | string literal |

Three rules follow from that table and are enforced in the walk:

- **Absent keys are omitted, never `undefined`.** The create pipeline should not see a key that
  carries no value.
- **`sh:value` only holds RDF terms.** A literal or a `{id}` reference is one; a plain object, array
  or function is not, so it is left off and the message names the offender instead. Cardinality
  violations carry no `sh:value` at all — they are about the property, not any one value.
- **IRI-valued fields are `{id}` refs, not bare strings** — including `focusNode` and `sourceShape`,
  which were strings in the first cut.

Two deliberate departures: `results` is plural where SHACL's repeated property is `sh:result` (a
shape class picks its own label for a path, so this still maps 1-1), and `propertyPath` — the dotted
label path — is a non-SHACL extension, because `sh:resultPath` names the property but not where the
nesting reached it. A pure-SHACL report drops that key; a report that keeps it needs one extension
property in its shape class. Standards-correct nesting would instead be `sh:detail` linking parent to
child results, which trades a flat list for a tree; the flat list is what a caller iterating
violations wants, so it stayed flat.

Ontology terms added: `MinCountConstraintComponent`, `MaxCountConstraintComponent`,
`NodeKindConstraintComponent`, `ClosedConstraintComponent`, `Warning`, `Info`, `resultMessage`
(distinct from the already-present `sh:message`, which declares a custom message on a *shape*), and
`detail` for the nesting option above.

`shape-validation-materialization.test.ts` proves the mapping rather than asserting it: it declares
shape classes straight from the SHACL vocabulary and pushes a real report through a create query. If
a result ever grows a key those shapes don't declare, the create throws `Invalid property key` and
the suite fails. Whether core ships those classes is left open — the test keeps the contract honest
either way.

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

## Value constraints (follow-up)

The deferred G5 components were then implemented, closing report 024's G5 gap on the write path:
`sh:datatype`, `sh:minInclusive` / `sh:maxInclusive` / `sh:minExclusive` / `sh:maxExclusive`,
`sh:minLength` / `sh:maxLength`, `sh:pattern`, and `sh:in`. Each is one entry in
`PROPERTY_CONSTRAINTS`, as the registry was designed for.

**Datatype mismatches are `sh:Violation`, not `sh:Warning`** — the plan recommended `Warning` for
coercible mismatches, and that recommendation was wrong. Mutation literals are typed from the
*JavaScript* value when they reach SPARQL (`irToAlgebra.ts:1646-1656`): a number becomes
`xsd:integer` or `xsd:double`, a boolean `xsd:boolean`, a `Date` `xsd:dateTime`, and a string an
untyped literal. A string handed to an `xsd:integer` property therefore does not merely skip a check
— it writes the wrong RDF term, silently. There is nothing to warn about; it is wrong.

Datatype rules, by JS value:

| Declared | Accepts |
| --- | --- |
| `xsd:string` | string |
| `xsd:boolean` | boolean |
| `xsd:integer`, `xsd:long` | number, integral |
| `xsd:decimal`, `xsd:float`, `xsd:double` | finite number |
| `xsd:date`, `xsd:dateTime`, `xsd:time` | `Date` |
| `xsd:duration`, `xsd:gYear`, `xsd:Bytes` | unchecked |

### Temporal properties take a `Date` and nothing else

A `Date` is the single accepted input for `xsd:date` / `xsd:dateTime` / `xsd:time` — one
representation for a point in time, rather than a JS object and a hand-written lexical string that
behave differently on the way out.

That required a **companion fix in the serializer**, because otherwise `xsd:date` would have become
unwritable: `irToAlgebra` typed every `Date` as `xsd:dateTime` from `toISOString()`, so an
`xsd:date` property would have stored a full timestamp with no way to express a plain date.
`fieldValueToTerms` now takes the property's declared `sh:datatype` and derives the lexical form from
it (`dateToTerm`):

| Declared | One `Date` of `2020-06-15T09:30:00Z` becomes |
| --- | --- |
| `xsd:date` | `"2020-06-15"^^xsd:date` |
| `xsd:dateTime` | `"2020-06-15T09:30:00.000Z"^^xsd:dateTime` |
| `xsd:time` | `"09:30:00.000Z"^^xsd:time` |
| none | `"…"^^xsd:dateTime` (unchanged) |

The datatype is resolved from the shape registry by property id — `resolvePropertyDatatype`, the same
scan and self-invalidating cache the predicate resolution already used — so neither the IR nor the
wire format changed.

**Numbers use the same hook.** A property declared `xsd:long` previously stored `xsd:integer`, and
one declared `xsd:decimal` stored `xsd:double`, because the term was inferred from the JavaScript
value — so the store round-tripped a different term than the shape said it held. `numericDatatype`
now prefers the declared datatype when it is one the DSL accepts a number for (`xsd:integer`,
`xsd:long`, `xsd:decimal`, `xsd:float`, `xsd:double`), falling back to inference when a property
declares none. Strings stay plain literals: `"a"` *is* an `xsd:string` in RDF 1.1, so emitting the
datatype explicitly would be noise.

### Set modifications are checked value-by-value

`{tags: {add: ['42']}}` used to skip every check — the whole `{add, remove}` object counted as
undecidable, which left the exact hole the datatype work had just closed everywhere else. Only the
*count* is undecidable: it depends on what the store already holds. Each added value is as checkable
as any other.

The registry is now split into `CARDINALITY_CONSTRAINTS` (`sh:minCount`, `sh:maxCount` — need the
whole value set) and `VALUE_CONSTRAINTS` (everything else — needs only the value in hand). A set
modification runs the value constraints over `add`, including recursion into nested creates, and
skips cardinality. `remove` is left to normalization, which already requires `{id}` references there.

Ordering matters more than it looks: `isSetModification` reads `.add` off the value, and a resolved
query-context reference is a proxy that throws on any undecorated key. Deferred values —
expressions, context refs, callbacks, `undefined` — are now ruled out by `isDeferredValue` *before*
anything reads a property off the value. The existing `mutation-serialization` suite caught this.

Two design rules keep the output readable: **one violation per mistake** — a node reference given to
a typed literal property is a node-kind violation only, and a non-number given to a bounded property
is a datatype violation only, with the bounds staying quiet — and **`sh:pattern` regexes are rebuilt
without `g`/`y` flags**, since those carry `lastIndex` between calls and a shape-level regex would
otherwise match every other value.

These are value-level checks, so they run in **both** modes. Only required-property *presence* needs
a complete node, and that remains create-only. `shape-validation-constraints.test.ts` locks that
split down explicitly.

## Still deferred
- **`sh:closed` as opt-in.** The undeclared-property check is unconditional, as before; SHACL makes it
  per-shape via `sh:closed` + `sh:ignoredProperties`, both already on `NodeShapeData`. Honouring the
  flag would stop rejecting unknown keys on non-closed shapes — a behaviour change, so it stays
  behind this decision.
- **Validating nodes read back from the store**, not just write payloads. The engine is shape-driven
  and would need only a different input adapter.
- **Shipping `ValidationReport` / `ValidationResult` shape classes in core** — filed as
  `docs/backlog/034-validation-report-shape-classes.md`. The mapping is settled and tested; what is
  open is whether core should own the classes, the `contains` semantics of `sh:result`, and the name
  collision with the interfaces of the same name.
- **`sh:languageIn` / `sh:uniqueLang`** — skipped at serialization time too (report 024, G5), so
  there is no metadata to enforce against yet.
- **A set modification can still exceed `sh:maxCount` undetected.** `{tags: {add: [1, 2, 3]}}` on a
  `maxCount: 1` property conforms, because the final count depends on the store. A lower bound is
  derivable (the number of *distinct* added values), but added values may duplicate ones already
  held, so the bound is only sound for distinct additions. Left alone rather than risk a false
  positive on a re-added value.
- **`sh:closed` as opt-in** — filed as `docs/backlog/035-sh-closed-opt-in.md`, with the options and
  the trade-off against the typo guard written up.
- **Strings are still written as plain literals**, not `"…"^^xsd:string`. That is the canonical RDF
  1.1 form for a string, so it is correct rather than a gap — noted because it is the one declared
  datatype the serializer deliberately does not emit.
