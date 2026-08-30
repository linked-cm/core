---
summary: Add a boolean existence check to the query API — `Shape.exists(id)` plus a terminal `.exists()` on SelectBuilder — so "does this node exist?" has a correct, cheap, non-swallowing expression instead of the `select().where(...).one().catch(() => null)` workaround.
status: Ideation
packages: [core]
---

# 001 — `Shape.exists()` — a boolean existence check

## Origin

Create Now carries this helper (`src/features/document-studio/services/LinkedDocumentRepository.ts`, CN repo — not ours to edit):

```ts
async function exists(shape: any, id: string): Promise<boolean> {
  return Boolean(await shape.select().where((item: any) => item.equals({id})).one().catch(() => null));
}
```

It is used on ~12 save paths to choose between `create` and `update`. It reportedly always
returns `false`, so every save takes the `create` branch.

## Finding — the "malformed SPARQL" diagnosis does not reproduce on 2.17.0

The brief attributes the failure to an empty `SELECT` projection (`SELECT  WHERE {…}`, Fuseki
parse error at column 3). That is **not** what this pipeline emits. `selectToAlgebra` has
unconditionally projected the root alias since commit `4aba4da` (Mar 2026):

`src/sparql/irToAlgebra.ts`
```ts
// Always include root alias as first projection variable
projection.push({kind: 'variable', name: rootAlias});
```

A probe of the exact CN call shape against this tree produces valid SPARQL:

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <https://linked.cm/shape/core/Person> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
LIMIT 1
```

and `mapSparqlSelectResult`'s no-projection fast path returns `{id}` or `null`, so `Boolean(...)`
is already the right conversion. The shipped `lib/esm` in CN's `node_modules` (2.17.0) contains the
same root-alias projection. So on current core the workaround is *functionally* correct, and CN's
failure is either an older core, a different failure being masked, or a shape without a resolvable
scan IRI — in every one of those cases **the `.catch(() => null)` is what hid it**.

That does not weaken the case for this feature, it sharpens it:

1. The workaround's correctness is **accidental** — it rests on an internal fast path
   (empty `resultMap` → `{id}` rows) that no test guards as public behaviour, and on
   `select()`-with-no-callback, which core's own test describes as *"selects nothing"*.
2. `.catch(() => null)` cannot distinguish "absent" from "the store is down". That is the
   real defect, and it is a defect the API *invites* because there is no honest alternative.
3. There is no way to express the question that reads as the question.

## Decisions

### Decision 1 of 5 — SPARQL form: reuse `SELECT … LIMIT 1`, do not add `ASK`

| Option | Cost | Verdict |
|---|---|---|
| **A. `SELECT DISTINCT ?a0 WHERE {…} LIMIT 1`** | zero pipeline change; works with every `IDataset` (Fuseki, Host Agent, remote/DSL-JSON) unchanged | **chosen** |
| B. Full `ASK` stack | ~15 files across 3 packages: `SparqlAskPlan`, `askPlanToSparql`, `AskQuery` wire op + wire-version bump, `IRAskQuery`, `mapSparqlAskResult` (`SparqlJsonResults` has no `boolean` field today), `IDataset.askQuery?`, `queryDispatch`, `LinkedStorage`, execution-gateway + backend store providers | rejected |

`ASK` is semantically the exact question, but against a triple store both forms are a single
indexed lookup bounded at one row; `ASK` saves one small JSON payload and nothing else. Option B
also puts a new **optional** method on `IDataset`, which means every non-Fuseki store either
implements it or silently falls back — reintroducing the "quiet wrong answer" failure mode this
work exists to remove. Long-term maintainability and store-portability decide it: reuse `SELECT`.

Recorded in backlog if `ASK` is ever wanted for its own sake (existence *without* the `rdf:type`
constraint, or a boolean on the wire).

Sub-decision: keep `.for(id)`'s `FILTER(?a0 = <iri>)` rather than switching to `forAll`'s
`VALUES`. `.for()` is the golden-tested house path and ARQ's filter-equality optimisation turns it
into the same substitution; a bespoke second binding form is not worth the divergence.

### Decision 2 of 5 — API shape: terminal `.exists()` on the builder, `Shape.exists(id)` as sugar

| Option | Verdict |
|---|---|
| A. `Shape.exists(id)` only | rejected — cannot answer "does anything match this where-clause?" |
| B. `Shape.exists(id)` + `Shape.exists(whereFn)` overloads | rejected — overload ambiguity, and duplicates `where()` |
| **C. `SelectBuilder.exists(): Promise<boolean>` terminal + `Shape.exists(id)` static sugar over it** | **chosen** |

One implementation, composable with everything the builder already expresses
(`Person.select().where(p => p.name.equals('Semmy')).exists()`), and the common case reads exactly
like the `.for({id})` calls it replaces. `Shape.exists` follows the `deleteAll` / `deleteWhere`
precedent of a one-line static delegating to a builder.

`Shape.exists` returns a real `Promise<boolean>`, not a builder. This deliberately breaks the
"statics return lazy builders" convention: `exists` is a terminal question, and handing back a
thenable is precisely how the current bug's ambiguity ("what does this resolve to?") arises.

### Decision 3 of 5 — the builder `.exists()` normalises the query to its cheapest form

`.exists()` drops everything that cannot change *whether* a row exists, and keeps everything that
can:

- **dropped**: projection (`selectFn` / `fieldSet` / `selectAllLabels`), `preloads`, sorting.
  Projections lower to `OPTIONAL` traversals, so they never gate row existence; sorting never does.
- **kept**: `where`, `minus`, subject / subjects, `offset`.
- **forced**: `limit: 1`.

So `Person.select(p => p.name).orderBy(p => p.name).exists()` costs exactly the same as
`Person.select().exists()`. This is what makes "cheapest correct SPARQL" a property of the API
rather than of how carefully the caller wrote the chain.

### Decision 4 of 5 — return type and conversion

`Promise<boolean>`, converted inside the function. `exec()` returns `{id}` / `null` under
`singleResult` and a `ResultRow[]` otherwise, so `.exists()` handles both:
`Array.isArray(r) ? r.length > 0 : r != null`. Callers never see a row or a null.

`.for(null | undefined)` (and an unresolved `PendingQueryContext`) already short-circuits to `null`
without touching the store — that maps to `false`, which is the correct total answer for
"does the node with no id exist?".

### Decision 5 of 5 — errors propagate, always

`.exists()` contains **no `try`/`catch`**. A store, transport or lowering failure rejects the
returned promise. This is the whole point: a failure must never be reportable as "does not exist".
Documented on both the method and the static.

## Route

Additive, `minor`. No IR, algebra, serializer, wire-format or `IDataset` change. Two new public
methods over the existing, already-golden-tested SELECT path, plus tests that pin the emitted
SPARQL so the shape of the query becomes guarded public behaviour rather than an accident.
