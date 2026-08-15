---
"@_linked/core": minor
---

**New: `validate(shape, data)`** — SHACL-aligned validation of a plain object against a shape, returning every violation at once instead of throwing on the first.

New root exports: `validate`, `assertValid`, `ShapeValidationError`, and the types `ValidationReport`, `ValidationResult`, `ValidationMode`, `ValidateOptions`, `ValidatableShape`.

```ts
import {validate} from '@_linked/core';

const report = validate(Slide, extractedFromDocument);
report.conforms; // false
report.results[0];
// {
//   sourceConstraintComponent: {id: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent'},
//   resultSeverity: {id: 'http://www.w3.org/ns/shacl#Violation'},
//   resultMessage: "Property 'title' requires at least 1 value(s), but none were provided.",
//   resultPath: {id: '…/props/title'},
//   propertyPath: 'title',
// }
```

No builder, no store round-trip. Pass `{mode: 'partial'}` to check only the values provided (an update) rather than the whole node (a create), and `{maxDepth}` to bound descent into nested creates. `assertValid()` is the throwing form; `ShapeValidationError.report` carries the same report.

Each result is one `sh:ValidationResult` under SHACL's own property names, with IRI-valued fields as `{id}` node references — so a report can be persisted by an ordinary create query against shape classes for `sh:ValidationReport` / `sh:ValidationResult`, with no transform step.

**Constraints now enforced on writes** that were previously parsed and serialized but never checked: `sh:datatype`, `sh:minInclusive` / `sh:maxInclusive` / `sh:minExclusive` / `sh:maxExclusive`, `sh:minLength` / `sh:maxLength`, `sh:pattern`, and `sh:in`. These check the value in hand, so they apply to creates, updates, and the values inside a `{add: […]}` set modification.

**Mutations arriving as DSL-JSON are validated too.** `lowerMutationJSON` previously checked only that each property existed on the shape, so an inbound mutation was held to a weaker standard than a locally-built one. It now runs the same validator, `complete` for creates and `partial` for updates.

**Behavioural changes to review before upgrading:**

- `Shape.create(data).toJSON()` now throws when a required (`minCount >= 1`) property is missing. Previously only `lower()` and `exec()` did — `toJSON()`, `lower()` and `exec()` now reject identical input.
- Required properties of *nested* creates are now checked; previously unchecked at any level.
- A failing mutation reports every violation rather than the first. Individual messages are unchanged; the aggregated `Missing required fields for 'X': a, b` message is replaced by one result per property.
- A mistyped literal is now rejected: `{age: '42'}` on an `xsd:integer` property throws. This is a correctness fix — mutation literals are typed from the JavaScript value when they reach SPARQL, so that string was being written as an untyped literal.
- Properties declared `xsd:date`, `xsd:dateTime` or `xsd:time` accept a JavaScript `Date` and nothing else; a lexical string is now a violation.
- The serializer honours the declared `sh:datatype` for temporal and numeric literals. One `Date` becomes `"2020-06-15"^^xsd:date` on an `xsd:date` property and a full timestamp on an `xsd:dateTime` one; a property declared `xsd:long` or `xsd:decimal` now emits that datatype instead of the `xsd:integer` / `xsd:double` inferred from the value. Neither the IR nor the wire format changed.

See `docs/reports/027-shape-validation-report.md` for the full mapping tables, design decisions, and known limitations.
