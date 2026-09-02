---
summary: Existence checks now emit SPARQL `ASK`. Adds `SparqlAskPlan`/`askPlanToSparql`/`askToAlgebra`/`mapSparqlAskResult` and an optional `IDataset.askQuery`, with the choice-and-degradation collapsed into one `resolveExistence` function that also enforces the boolean contract — so a store without a boolean primitive answers the same normalised `SELECT … LIMIT 1` as before, and no store can answer the question differently.
source_plan: docs/plans/002-ask-query-support.md (converted; plan removed)
packages: [core]
---

# 029 — `ASK` query support

Status: **done**. Suite **68 suites / 1699 passed / 120 skipped**, typecheck green (baseline before
this work: 1654 passed). Additive `minor`.

Stacked on PR #206 (`feat/shape-exists`, report 028) — `.exists()` is the consumer and is not yet
merged. Merges after it.

## Why, given 028 rejected `ASK`

Report 028 deferred `ASK` to backlog 036 on two claims. Both survive scrutiny; neither is a reason
not to do the work, and the case for doing it is a different one from the case that was rejected.

1. **`ASK` is not faster.** True, and this change does not claim otherwise. Against a triple store
   both forms are one indexed lookup bounded at a single solution. `ASK` saves a small JSON payload
   and the engine's `DISTINCT` bookkeeping. Anyone reading this expecting a latency win should stop
   here — there isn't one.
2. **An optional `IDataset` method means non-implementing stores silently fall back.** True as
   stated, and the right call at the time. It is answerable by *placement* — see "The degradation"
   below.

What makes it worth doing is that `ASK` is the only top-level query kind whose result is a **fixed
scalar**. Every other kind travels through `mapSparqlSelectResult` (~320 lines), `FieldSet`,
`resultMap` and the DSL result-type generics. `ASK` needs `json.boolean`. So it exercises the entire
"new top-level query kind" seam — a plan type in the algebra union, a serializer, an `IDataset`
method, a dispatch route — while touching **zero** result-shape machinery. It is the cheapest
available rehearsal for `CONSTRUCT` (backlog 004), which walks the same seam carrying a far heavier
result mapping. Secondary benefit: the emitted query now reads as the question the caller asked.

## What it does

```sparql
ASK WHERE {
  ?a0 rdf:type <https://linked.cm/shape/core/Person> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
```

`.exists()`'s normalisation is **unchanged** from 028 — drop the projection, preloads, sorting and
pagination; keep filters, `minus` and the subject; `LIMIT 1`. `ASK` is a substitution at the *store*
boundary, not a change to what the builder asks for. Two payoffs: the existing SELECT goldens pass
untouched, so the degradation is provably identical to what shipped; and the `ASK` goldens derive
from the same captured IR, which makes "the two forms ask the same thing" a tested claim rather than
an assertion (`sparql-ask-golden.test.ts` strips both envelopes and compares the WHERE bodies).

## The degradation — the 028 objection, answered by placement

`IDataset.askQuery` is optional. Adding it as required would break every external store
implementation to buy a JSON payload. Two things defuse the silent-fallback objection:

- **The fallback is not a wrong answer.** It is the golden-tested `SELECT … LIMIT 1` that ships
  today. A store that cannot `ASK` still *rejects* on transport failure exactly as it does now. The
  failure mode 028 removed was `.catch(() => null)` turning an unreachable store into `false`;
  nothing here reintroduces it.
- **One function owns the whole contract.** `resolveExistence(target, query)` in `queryDispatch.ts`
  makes the choice, performs the degradation, and enforces what a store may answer with. Both call
  sites that can meet a target without `askQuery` go through it: `SelectBuilder._run` (the dispatch
  has none) and `LinkedStorage.askQuery` (the dispatch has one, the *routed* dataset does not).
  Neither branches for itself.

## Decisions

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Stack on PR #206 | Branch from `dev` — would re-implement 861 lines and guarantee a conflict |
| 2 | Scope to the SPARQL layer + dispatch seam | Backlog 036's full survey; type-free existence and the wire op stay backlogged (below) |
| 3 | `askQuery` optional, one shared `resolveExistence` | Required `askQuery` (breaking); per-store fallbacks (N implementations to get wrong) |
| 4 | `_run` gains a `mode` | A parallel execution path — would duplicate the null-subject guard, the pending-context guard, the error wrapping and the non-swallowing of `UnresolvedContextError` |
| 5 | No wire change | `op:'ask'` — unnecessary, since a remote store degrades and forwards the same select envelope it always did |
| 6 | `askToAlgebra` **rejects** `OFFSET`/`LIMIT < 1` | Dropping them silently — `SELECT … LIMIT 0` answers "no rows" where `ASK` answers `true` |
| 7 | `.exists()` normalisation unchanged | Normalising differently per path — would make the two forms untestable against each other |

### Out of scope, deliberately

**Type-free existence** (`ASK { <uri> ?p ?o }`) is the more valuable feature and is *not* here.
Every select scan emits `?a0 rdf:type <ShapeClass>`, so `Person.exists(id)` means "exists as a
Person" — correct, but there is still no way to ask whether an IRI exists at all. That needs a new
non-shape-scoped entry point, which is a new public capability nobody has asked for; adding it here
would be widening the API on my own initiative. Rewritten as backlog 036 with the ~20-line sketch.

## The result-type ripple

`SparqlJsonResults` has no `boolean` field, and an `ASK` response carries no `results` key at all.
Adding `boolean?` to the existing type would have made it describe a shape no endpoint returns.
Instead: a sibling `SparqlAskResults`, a `SparqlQueryResults` union, and
`SparqlDataset.executeSparqlSelect` widened to the union — its docstring has always advertised
`SELECT/ASK/CONSTRUCT`. Return-position widening leaves every existing implementation assignable, so
no store breaks; one narrowing guard in `selectQuery` pays for it. `rawQuery` widens with it, which
is the one caller-visible type change (narrow with the exported `isSparqlSelectResults`).

Verified against the real endpoint rather than assumed — a live-Fuseki test asserts
`{head: {}, boolean: true|false}` exactly.

## Iteration pass — two gaps found reviewing the diff

Both were the same class of defect this API family exists to eliminate: an answer that is quietly
wrong rather than loudly absent.

**1. A non-boolean from `askQuery` was coerced into `true`.** `.exists()`'s conversion was
`result != null`. Once a store could return a boolean, a store returning anything *else* truthy —
`{}`, a row array, `'true'` — read as "exists". `resolveExistence` now rejects a non-boolean instead
of coercing it, and `_run` handles a genuine `false` explicitly (`result != null` would have read
`false` as present — the sharpest single bug risk in the change, flagged during ideation and now
covered directly).

**2. The two paths disagreed on pagination.** `askToAlgebra` refuses `OFFSET` and `LIMIT < 1`. The
SELECT degradation would happily *honour* both — so the same query put to two different stores could
answer differently. The guard moved in front of both, into `resolveExistence`. Unreachable through
`.exists()` (which normalises pagination away first), but `LinkedStorage.askQuery` and
`IDataset.askQuery` are public.

Also in the pass: `Shape.exists` and `SelectBuilder.exists` docstrings still showed the `SELECT`
form as the emitted query; backlog 036 rewritten to cover only what remains; and one clause in
`.changeset/shape-exists.md` scoped ("on its own it needs no … `IDataset` change") so the published
changelog does not contradict itself when both changesets release together.

## Tests

45 new (1654 → 1699), across five files:

- `sparql-ask-golden.test.ts` (new, 12) — literal `ASK` output; every `existsFactories` fixture's
  ASK body compared against its SELECT body; the `OFFSET` / `LIMIT 0` guards, including a direct
  demonstration that `selectToSparql` really does emit `LIMIT 0` where `ASK` would answer `true`.
- `query-builder.test.ts` (+17) — `askQuery` preferred and `selectQuery` not also called; the
  normalised query is what `askQuery` receives; `false` resolves `false`; six non-boolean answers
  each reject; failures and `UnresolvedContextError` still reject; null id short-circuits without
  dispatch; `exec()` never takes the ASK path; both guards refuse on both kinds of store.
- `store-routing.test.ts` (+4) — `LinkedStorage.askQuery` routes to the pinned dataset, degrades for
  a dataset without `askQuery`, propagates failures, rejects a shapeless query.
- `sparql-result-mapping.test.ts` (+8) — the boolean maps through; a SELECT result set **throws**
  rather than being coerced; malformed responses throw.
- `sparql-fuseki-coverage.test.ts` (+4) — against live Fuseki: the wire really carries `ASK` and no
  `SELECT`/`LIMIT`; the response shape matches `SparqlAskResults`; ASK and the SELECT degradation
  agree on eight fixtures against the same data; the type triple survives.

028's eleven live-Fuseki `.exists()` tests now run *through* `ASK` (a `FusekiStore` inherits
`askQuery`) and pass unmodified — the strongest single piece of evidence that the substitution is
behaviour-preserving.

**Environment note.** Docker is unavailable in this container, so the suite's usual Fuseki
auto-start could not run. Fuseki 5.5.0 was instead run directly on the JVM
(`java -jar jena-fuseki-server-5.5.0.jar --mem --port=3939 /nashville-test`), which serves the same
admin API the test helper uses. All three `sparql-fuseki*` suites (188 tests) executed and passed
against it; nothing was skipped that CI would run.

## Follow-ups

- Backlog **036** (rewritten) — type-free existence, and `op:'ask'` if a remote peer should ever
  answer the boolean itself.
- Backlog **004** (`CONSTRUCT`) — the seam this change rehearsed. `resolveExistence`'s shape is the
  pattern to copy; the result-mapping cost is where the two diverge.
