---
summary: Add SPARQL ASK end-to-end (algebra, serializer, wire op, IDataset.askQuery) if a boolean is ever needed on the wire or existence is needed without the shape's rdf:type scan. Deliberately not done for `Shape.exists`, which lowers to an ordinary SELECT.
packages: [core]
---

# 036 — `ASK` query support

`Shape.exists()` / `SelectBuilder.exists()` (report 028) answer existence with
`SELECT DISTINCT ?a0 WHERE { … } LIMIT 1`, not `ASK`. That was chosen deliberately: it needs no
pipeline change and therefore works on every `IDataset` — Fuseki, Host Agent, remote/DSL-JSON —
without any store opting in.

Reasons `ASK` might still be wanted later:

- **Existence without the type constraint.** Every select scan emits `?a0 rdf:type <ShapeClass> .`
  (`irToAlgebra.ts`, `resolveShapeScanIri`). So `Person.exists(id)` means "exists *as a Person*".
  There is currently no way to ask "is there any node with this IRI at all?".
- A boolean on the wire rather than a one-row result set.

What it would take (surveyed, not started):

| Layer | File | Change |
|---|---|---|
| Algebra | `src/sparql/SparqlAlgebra.ts` | `SparqlAskPlan` in the `SparqlPlan` union |
| Serializer | `src/sparql/algebraToString.ts` | `askPlanToSparql` → `ASK WHERE { … }` |
| IR → algebra | `src/sparql/irToAlgebra.ts` | `askToAlgebra` / `askToSparql` (reuse `selectToAlgebra`'s pattern build, drop steps 7–9) |
| Result mapping | `src/sparql/resultMapping.ts` | `SparqlJsonResults` has **no `boolean` field** today; widen it + `mapSparqlAskResult` |
| IR | `src/queries/IntermediateRepresentation.ts` | `IRAskQuery`, `AskResult = boolean` |
| Wire | `QueryBuilderSerialization.ts`, `fromJSON.ts`, `wireVersion.ts` | `op: 'ask'` + wire-version bump |
| Contract | `src/interfaces/IDataset.ts` | `askQuery?(q): Promise<boolean>` |
| Dispatch | `queries/queryDispatch.ts`, `utils/LinkedStorage.ts` | routing |
| Downstream | `packages/execution-gateway`, `packages/server` (`BackendAPIStoreProvider`) | endpoint method |

~15 files across 3 packages. Note the trap: an **optional** `askQuery` on `IDataset` means every
store that does not implement it either errors or silently falls back — reintroducing the
quiet-wrong-answer failure mode that `exists()` was built to remove. Any implementation should make
the fallback to SELECT explicit and shared, not per-store.
