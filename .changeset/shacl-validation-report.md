---
"@_linked/core": minor
---

Add `validate(shape, data)` — SHACL-aligned validation of a plain data object against a shape, returning a `ValidationReport` (`conforms` + `results`) instead of throwing on the first problem. `assertValid()` throws a `ShapeValidationError` carrying the same report. Pass `{mode: 'partial'}` to check only the values provided (an update) rather than the whole node (a create).

The report is 1-1 with the SHACL vocabulary and materializable as-is: each result carries `focusNode`, `resultPath`, `value`, `sourceShape`, `sourceConstraintComponent`, `resultSeverity` and `resultMessage` under those names, with IRI-valued fields as `{id}` node references and `sh:value` present only when the offending value is an RDF term. Given shape classes for `sh:ValidationReport` / `sh:ValidationResult`, `ValidationReport.create(report)` works with no transform step. Two documented departures: `results` is plural where the repeated SHACL property is `sh:result`, and `propertyPath` (the dotted label path through nested shapes) is a non-SHACL extension.

The create and update pipelines now run on this validator, which fixes an asymmetry: `create(data).toJSON()` previously accepted data that `lower()` and `exec()` rejected, because required-field checks lived in lowering while value checks lived in normalization. All three now reject the same input, and report every violation at once rather than only the first. Nested node descriptions are validated too, including their required properties — which were previously unchecked. Structural coverage is unchanged otherwise (cardinality, node kind, undeclared properties); datatype, pattern, length and value-range constraints remain serialization-only, enforced by the store.
