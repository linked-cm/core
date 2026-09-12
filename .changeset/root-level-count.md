---
'@_linked/core': minor
---

Adds a root-level count to the query DSL: `SelectBuilder.from(shape).where(…).count()` and
`Shape.count()` resolve to a real `number`, lowering to `SELECT (COUNT(DISTINCT ?s) AS ?count)
WHERE { … }`. Like an ask, a count is its own builder and IR kind, so `limit`/`offset` are dropped at
the boundary and unrepresentable thereafter — the count of a window is the count of the whole match
set. `.toCount()` is public so a router can forward the `{op: 'count'}` envelope instead of executing
it.

`IDataset.countQuery` is **optional**, so nothing breaks: every store extending `SparqlDataset` gets
it with no edit. A store or router that does not extend `SparqlDataset` — including any
`setQueryDispatch({…})` object literal in a consuming package — needs a `countQuery` arm added by
hand before `.count()` works against it; until then it fails loudly, naming the method.
