---
'@_linked/core': minor
---

Adds a root-level count to the query DSL: `SelectBuilder.from(shape).where(…).count()` and
`Shape.count()` resolve to a real `number`, lowering to `SELECT (COUNT(DISTINCT ?s) AS ?count)
WHERE { … }`. Like an ask, a count is its own builder and IR kind, so `limit`/`offset` are dropped at
the boundary and unrepresentable thereafter — the count of a window is the count of the whole match
set. `IDataset.countQuery` is optional; every store extending `SparqlDataset` gets it with no edit.
