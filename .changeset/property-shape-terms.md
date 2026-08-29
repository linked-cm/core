---
'@_linked/core': minor
---

Expose the meta-model's SHACL constraint table via `getPropertyShapeTerms()` /
`getPropertyShapeTerm(label)`, so an alternative serializer can look up each constraint's
predicate, datatype and node kind rather than hard-coding its own copy.

Purely additive — `buildPropertyShapeData` is unchanged. Create Now's code→RDF shape sync uses
this to emit the full SHACL constraint set (pattern, `sh:in`, ranges, lengths, class) instead of
the five it previously enumerated by hand.
