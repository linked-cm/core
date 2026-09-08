---
'@_linked/core': patch
---

Read result bindings under the same sanitized variable name they were written with.

`algebraToString` sanitizes a projection into a legal SPARQL variable — only letters, digits
and underscore survive — while `resultMapping` derived the name it reads back without doing
the same. A property named by a person ("Volume share", "Avg. basket") was therefore emitted
as `?a0_Volume_share` and looked up as `a0_Volume share`, matching no binding: the value came
back `null` with no error, for every multi-word property, on every query. Single-word names
were unaffected, which made it look like missing data rather than a naming mismatch.
