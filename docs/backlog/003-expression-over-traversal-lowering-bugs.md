---
summary: Three correctness bugs in expression-over-traversal lowering surfaced by E2E coverage tests — invalid SELECT SPARQL and silent UPDATE data corruption.
---

# Expression-over-traversal lowering bugs

Surfaced by `src/tests/sparql-fuseki-coverage.test.ts` (plan 001, Phase 1)
running fixtures through the live Fuseki store. Golden tests missed these
because they only assert substring presence, not SPARQL validity or result
correctness.

## Bug 1 — SELECT: computed expression over a traversal emits invalid SPARQL

`Person.select(p => p.bestFriend.name.ucase())` (fixture `exprNestedPath`)
generates:

```sparql
SELECT DISTINCT ?a0 (UCASE(?a1_name) AS ?a1)
WHERE { ?a0 rdf:type <…/Person> . ?a0 <…/bestFriend> ?a1 .
        OPTIONAL { ?a1 <…/name> ?a1_name . } }
```

→ Fuseki 400: `Variable used when already in-scope: ?a1 in ((ucase ?a1_name) AS ?a1)`.
The projection alias reuses the traversal's own variable `?a1`. Fix: allocate a
fresh alias (e.g. `?a1_expr`) for an expression projection that wraps a traversal.
Likely localized to projection-alias generation in `src/sparql/irToAlgebra.ts`.

## Bug 2 — UPDATE: expression over a traversal is unscoped (data corruption)

`Person.update(p => ({hobby: p.bestFriend.name.ucase()})).for(p1)` (fixture
`updateExprTraversal`). `p1` has **no** `bestFriend`, so the expected result is
"no change". Actual: `p1.hobby` was overwritten with the UCASE of **every**
person's name (`SEMMY, MOA, QUINN, JINX, MAXIMILIAN`) and the original value
removed. The traversal is not joined to the update target — it ranges over all
entities.

`updateExprSharedTraversal` (two fields off `p.bestFriend`) has the same defect
and additionally overwrote `p1.name` (a maxCount:1 property) with five values.

This is silent data corruption in a mutation path. Fix is in the mutation
expression lowering (`src/queries/mutationLowerSpec.ts` /
`src/sparql/irToAlgebra.ts` update path) — the traversal must be constrained to
the update subject.

## Status

Quarantined in the coverage suite:
- `updateExprTraversal`, `updateExprSharedTraversal` → `test.skip` with BUG note.
- `exprNestedPath` → not added as a test (documented here).

Decision pending (plan 001): fix now vs. defer. Bug 2 (mutation correctness) is
the higher priority and the likelier-to-balloon fix.
