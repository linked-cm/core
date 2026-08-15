---
"@_linked/core": minor
---

Add `validate(shape, data)` — SHACL-aligned validation of a plain data object against a shape, returning a `ValidationReport` (`conforms` + `results`) instead of throwing on the first problem. Each result mirrors `sh:ValidationResult`: `focusNode`, `path`, `value`, `sourceShape`, `sourceConstraintComponent`, `severity` and `message`, with vocabulary-valued fields carried as `{id}` node references from the `shacl` ontology so a consumer with a triple layer can map a report mechanically. `assertValid()` throws a `ShapeValidationError` carrying the same report. Pass `{mode: 'partial'}` to check only the values provided (an update) rather than the whole node (a create).

The create and update pipelines now run on this validator, which fixes an asymmetry: `create(data).toJSON()` previously accepted data that `lower()` and `exec()` rejected, because required-field checks lived in lowering while value checks lived in normalization. All three now reject the same input, and report every violation at once rather than only the first. Nested node descriptions are validated too, including their required properties — which were previously unchecked. Structural coverage is unchanged otherwise (cardinality, node kind, undeclared properties); datatype, pattern, length and value-range constraints remain serialization-only, enforced by the store.
