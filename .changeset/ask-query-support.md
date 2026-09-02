---
'@_linked/core': minor
---

Existence checks now run as SPARQL `ASK`.

`Shape.exists(id)` and `SelectBuilder.exists()` emit `ASK WHERE { … }` against any store that
implements the new optional `IDataset.askQuery`, which every `SparqlDataset` now does:

```sparql
ASK WHERE {
  ?a0 rdf:type <https://linked.cm/shape/core/Person> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
```

Public API:

- **`IDataset.askQuery?(query): Promise<boolean>`** — optional. Implement it when the backend has a
  cheaper boolean primitive. It must resolve to a real boolean and must reject on failure; a
  non-boolean is rejected rather than coerced, since a truthy value would silently read as "exists".
- **`LinkedStorage.askQuery(query)`** — routes an existence check to the shape's dataset.
- **`askToAlgebra` / `askToSparql` / `askPlanToSparql` / `SparqlAskPlan`** — the `ASK` arm of the
  SPARQL layer, alongside the `select*` equivalents.
- **`mapSparqlAskResult`**, **`SparqlAskResults`**, **`SparqlQueryResults`**,
  **`isSparqlSelectResults`** — an `ASK` response carries `boolean` and no `results` key, so it is a
  sibling type rather than an optional field on `SparqlJsonResults`.

**Nothing is required of existing stores.** A dataset without `askQuery` degrades through one shared
path to the same normalised `SELECT … LIMIT 1` that shipped previously — a slower answer, never a
different one, and still rejecting rather than reporting an unreachable store as `false`. No wire
format, IR or result-mapping change: a remote store keeps sending exactly what it sent before.

Two type-level notes for anyone implementing `SparqlDataset` directly:

- `executeSparqlSelect` now returns `SparqlQueryResults` (select result set **or** ask answer).
  Implementations returning the narrower `SparqlJsonResults` stay valid — return types are
  covariant — but a caller reading `.results` off a `rawQuery()` result now needs to narrow, e.g.
  with the exported `isSparqlSelectResults`.
- `askToAlgebra` **rejects** `OFFSET` and `LIMIT < 1` rather than dropping them: `ASK` cannot
  express pagination, and `SELECT … LIMIT 0` answers "no rows" where `ASK` answers `true`. The same
  guard runs in front of the SELECT degradation, so the two paths cannot disagree. `.exists()`
  normalises pagination away before dispatching, so this only affects direct `askQuery` callers.
