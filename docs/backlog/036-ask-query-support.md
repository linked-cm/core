---
summary: What is left of ASK after report 029 shipped it — type-free existence (`ASK { <uri> ?p ?o }`, which no API can express today) and an `op:'ask'` wire envelope for a remote store that wants to answer the boolean itself rather than degrading to SELECT.
packages: [core]
---

# 036 — `ASK`: what remains

`ASK` itself landed in report 029. `Shape.exists()` / `SelectBuilder.exists()` now emit
`ASK WHERE { … }` against any store implementing `IDataset.askQuery` (every `SparqlDataset`), and
degrade to the original `SELECT … LIMIT 1` on stores that do not. Two items from the original
survey were deliberately left out of that change.

## 1. Existence without the type constraint — the valuable one

Every select scan emits `?a0 rdf:type <ShapeClass> .` (`irToAlgebra.ts`, `resolveShapeScanIri`), and
`selectToAlgebra` throws without a `query.root`. So `Person.exists(id)` means "exists **as a
Person**" — correct for what it is, but there is still no way to ask the plain question:

```sparql
ASK { <uri> ?p ?o }
```

"Is there any node with this IRI at all", independent of shape. That is a different question from
anything the query DSL currently expresses, and it needs a non-shape-scoped entry point —
`LinkedStorage.nodeExists(uri)` or similar, *not* an option on `Shape.exists()`, which is
shape-scoped by design.

It does not need the IR: `selectToAlgebra` cannot express a rootless scan, but nothing forces this
through `selectToAlgebra`. The cheap version is a direct serializer plus a dispatch route:

```ts
export function nodeExistsToSparql(iri: string): string {
  return `ASK WHERE { ${formatUri(iri)} ?p ?o }`;
}
```

~20 lines plus the entry point and its routing. The reason it is not done: it is a new public
capability, not a re-plumbing of an existing one, and no caller has asked for it yet.

## 2. `op: 'ask'` on the DSL-JSON wire

Not needed today, and that is a property of how the degradation was placed rather than an
oversight. A remote/DSL-JSON store forwards `query.toJSON()`; it does not implement `askQuery`, so
it takes the shared `askViaSelect` and forwards an ordinary select envelope — exactly what it sent
before. Nothing new crosses the wire.

It becomes worth doing only when a remote peer should answer the boolean *itself* — saving a result
set on the far side of the network, which is where the payload difference stops being noise. That
is the ~15-file, 3-package change the original survey described: `QueryBuilderSerialization`,
`fromJSON`, wire version, plus `execution-gateway` and `server`.

One thing that survey got slightly wrong, checked since: a wire-version bump is not what protects an
old peer. `assertWireVersion` only rejects on a **major** mismatch, so `1.0 → 1.1` gates nothing.
What protects it is `fromJSON.ts`, which throws `Unknown query op` on an unrecognised `op` rather
than falling through to `SelectBuilder` — so an old peer fails loud instead of silently re-running
the query as a SELECT. The ordering constraint is still real: deploy the receiving side first.
