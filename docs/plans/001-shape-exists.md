---
summary: Add a boolean existence check to the query API — `Shape.exists(id)` plus a terminal `.exists()` on SelectBuilder — so "does this node exist?" has a correct, cheap, non-swallowing expression instead of the `select().where(...).one().catch(() => null)` workaround.
status: Review
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

---

## Plan

### Contracts

```ts
// src/queries/QueryBuilder.ts — on SelectBuilder
/**
 * Whether any row matches this query. Executes immediately and resolves to a
 * boolean — never a row, never null.
 *
 * Errors are NOT swallowed: a store or transport failure rejects. "Does not
 * exist" and "could not ask" stay distinguishable.
 */
exists(target?: IDataset): Promise<boolean>;

// src/shapes/Shape.ts — static
/**
 * Whether a node with this id exists as an instance of this shape.
 * `Person.exists({id})` / `Person.exists('linked://…')`.
 * A null/undefined id resolves to `false` without querying.
 */
static exists<S extends Shape>(
  this: ShapeConstructor<S>,
  id: string | NodeReferenceValue | PendingQueryContext | null | undefined,
  target?: IDataset,
): Promise<boolean>;
```

### Implementation of `SelectBuilder.exists`

```ts
exists(target?: IDataset): Promise<boolean> {
  return this.clone({
    // drop anything that cannot change whether a row exists
    selectFn: undefined,
    fieldSet: undefined,
    selectAllLabels: undefined,
    preloads: undefined,
    sortByFn: undefined,
    sortDirection: undefined,
    _sortBy: undefined,
    // cheapest correct bound
    limit: 1,
  })
    .exec(target)
    .then((r) => (Array.isArray(r) ? r.length > 0 : r != null));
}
```

`clone()` spreads `...overrides` last, so explicit `undefined` values do clear the fields.
No `catch` anywhere in the chain — by design.

`Shape.exists` is `SelectBuilder.from(this).for(id).exists(target)`. `.for()` already sets
`singleResult` and handles `null` / `PendingQueryContext`.

### Emitted SPARQL (the contract the tests pin)

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT DISTINCT ?a0
WHERE {
  ?a0 rdf:type <https://linked.cm/shape/core/Person> .
  FILTER(?a0 = <linked://tmp/entities/p1>)
}
LIMIT 1
```

One variable, one type triple, one equality filter, `LIMIT 1`. No `OPTIONAL`, no property
predicates, no `ORDER BY` — regardless of what was chained before `.exists()`.

### Files

| File | Change |
|---|---|
| `src/queries/QueryBuilder.ts` | add `exists()` terminal to `SelectBuilder` |
| `src/shapes/Shape.ts` | add `static exists()` next to `selectAll` |
| `src/test-helpers/query-fixtures.ts` | add `existsById` / `existsWhere` query factories for the golden suite |
| `src/tests/query-builder.test.ts` | IR-level assertions (normalisation, limit, subjectId, no projection) |
| `src/tests/sparql-select-golden.test.ts` | exact SPARQL golden for both entry points |
| `src/tests/sparql-fuseki-coverage.test.ts` | true / false / where-clause against real Fuseki |
| `.changeset/shape-exists.md` | minor |
| `docs/reports/028-shape-exists.md` | report (wrapup) |

### Pitfalls

- **`p.id` is not projectable.** `QueryShape.get id()` returns `undefined` on the proxy target, and
  `FieldSet.traceFieldsWithProxy` silently returns `[]` — so `select(p => p.id)` is indistinguishable
  from `select()`. Do not build on it; rely on the root-alias projection instead.
- **`exec()` re-wraps errors** in a plain `Error` with the stack stringified. `.exists()` must not
  add a second layer and must not catch.
- **`UnresolvedContextError` → `null`** inside `exec()`. That is an existing, deliberate
  short-circuit and correctly reads as `false` here; do not special-case it.
- **`Boolean(row)` vs `row != null`**: use the explicit null check. A row is always an object, but
  the array branch needs `length > 0` and mixing the two under `Boolean()` would silently accept
  `[]` as true.
- `clone()` must receive every cleared key explicitly — omitting one carries the old value through.

### Non-goals

`ASK`, existence without the `rdf:type` scan, and a boolean on the DSL-JSON wire. Backlogged.

---

## Phases

Dependency graph: **P1 → P2 → P3 → P4**. P1 is the only phase producing runtime code; P2/P3 are
test-only and could run in parallel with each other, but P3 needs the fixtures added in P2, so they
are sequenced. P4 is docs/release metadata and depends on the final test counts.

### Phase 1 — `exists()` on the builder and the shape — **done**

- [x] `SelectBuilder.exists(target?: IDataset): Promise<boolean>` in `src/queries/QueryBuilder.ts`,
      placed after `one()`. Clears projection / preloads / sorting, forces `limit: 1`, no `catch`.
- [x] `static exists()` in `src/shapes/Shape.ts`, placed directly after `selectAll`, delegating to
      `QueryBuilder.from(this).for(id).exists(target)`.
- [x] TSDoc on both stating: returns a real boolean, and errors reject rather than reading as `false`.

**Validation:** `npm run typecheck` clean. ✅ (`Shape.ts` needed two new type-only imports:
`PendingQueryContext`, `IDataset`.)

### Phase 2 — IR-level tests — **done**

- [x] Add `existsById`, `existsWhere` and `existsNormalised` factories to `src/test-helpers/query-fixtures.ts`.
- [x] In `src/tests/query-builder.test.ts`, a `describe('SelectBuilder — .exists()')` group asserting on
      `lower(...)` of the normalised builder: `projection.length === 0`, `resultMap.length === 0`,
      `limit === 1`, `sortBy` absent, `subjectId` set for the `.for()` form, `where` preserved for the
      where form, and that a chained `.select(p => p.name).orderBy(...)` normalises to the same IR as
      a bare `.exists()`.
- [x] Assert `Person.exists(null)` resolves `false` without dispatching.
- [x] **Moved up from Phase 3:** the store-failure test. It needs no Fuseki (a stub `IDataset`
      whose `selectQuery` throws is enough) so it belongs in the always-run suite rather than the
      docker-gated one — the anti-regression test for the original bug must never be skippable.
- [x] Also asserted: `.exists()` returns a `Promise`, not a chainable builder.

**Validation:** 8 new tests pass, `query-builder.test.ts` 94 passed, no existing test changed. ✅

### Phase 3 — SPARQL golden + live Fuseki — **done**

- [x] In `src/tests/sparql-select-golden.test.ts`, exact-string goldens for `existsById` and
      `existsWhere` in the house `expect(sparql).toBe(\`…\`)` style — pinning that the query has one
      projected variable, no `OPTIONAL`, no `ORDER BY`, and `LIMIT 1`.
- [x] In `src/tests/sparql-fuseki-coverage.test.ts`, a `describe` covering: existing id → `true`;
      absent id → `false`; a where-clause that matches → `true`; one that does not → `false`; and a
      wrong-shape id (a `Dog` iri asked of `Person`) → `false`. Each test guarded by
      `if (!fusekiAvailable) return;`.
- [x] A test that a store failure **rejects** rather than resolving `false` — done twice: with a
      stub dataset in Phase 2 (always runs) and with a real `FusekiStore` pointed at a non-existent
      dataset here.

**Validation:** 3 goldens byte-exact; `sparql-fuseki*` **185 passed / 3 suites** with Docker up. ✅

**Deviation — `test:fuseki` was missing `--runInBand`.** Running the documented command failed
~40 pre-existing tests before my changes too: the three `sparql-fuseki*` suites share one Fuseki
dataset (`nashville-test`) and clobber each other's seed data when Jest runs them in parallel
workers. `npm test` has always passed because *it* passes `--runInBand`. Added the same flag to
`test:fuseki` — a one-word fix, but without it the new tests are not runnable via the command the
repo documents for them.

### Phase 4 — changeset, report, PR

- [ ] `.changeset/shape-exists.md` — `'@_linked/core': minor`, prose in house style.
- [ ] `docs/reports/028-shape-exists.md` — convert the plan, matching report 027's structure
      (status line with suite counts, problem, API, design decisions, test coverage table, deferred).
- [ ] Remove `docs/plans/001-shape-exists.md`.
- [ ] Branch `feat/shape-exists`, PR into **`dev`** (never `main`), watch checks.

**Validation:** full `npm test` green (baseline 67 suites / ~1626 tests + typecheck), changeset present.


---

## Review

Phase 4 validation was green (67 suites, 1645 passed, typecheck clean) but an independent read of
the diff found four correctness defects — one of them in the *design* recorded during ideation.

| # | Finding | Severity |
|---|---|---|
| R1 | `.exists()` kept `offset` while dropping the projection. Those are not independent: `OFFSET` skips rows of the **solution sequence**, whose cardinality depends on the projection. `Person.select(p => p.friends.name).for(p1).offset(1).exists()` answered `true` un-normalised (2 friend rows, skip 1) and `false` normalised (1 row, skip 1). The same chain, opposite answers. | high |
| R2 | `exec()` converts `UnresolvedContextError` to `null` ("not ready", a reactive layer re-runs). `.exists()` inherited that and flattened it to `false` — the exact "could not ask reported as does not exist" failure this feature exists to eliminate, and directly contrary to its own TSDoc. | high |
| R3 | `Shape.exists('bad-prefix:x')` threw **synchronously** out of `resolveUriOrThrow` inside `.for()`, escaping a caller's `.catch()` despite the declared `Promise<boolean>`. | medium |
| R4 | The Fuseki "ignores projection and sorting" test was a tautology — projected properties already lower to `OPTIONAL` and `ORDER BY` never drops rows, so it passed identically with normalisation removed entirely. Several other tests injected a fake dataset and so only exercised the boolean mapping. | test quality |

Also noted, not acted on: all seven Fuseki suites share one hardcoded dataset (`nashville-test`),
so any run without `--runInBand` corrupts itself. The `test:fuseki` script was fixed in Phase 3;
the shared-dataset design is pre-existing — backlogged.

## Iteration 1 — Ideation

### Gap 1 of 3: pagination in an existence check (R1)

Three ways out: (a) honour `offset` by keeping the projection when one is set — restores
correctness but makes the query's cost depend on an unrelated chain element, defeating "cheapest
correct"; (b) reject when `offset` is set — safe, but hostile for a chain assembled elsewhere;
(c) **drop pagination entirely**.

Chose (c). It makes the normalisation rule total and statable in one line — *`exists()` answers a
question about the match set, not about a page of it* — and removes a special case rather than
adding one. `limit` is dropped for the same reason, which also settles the degenerate
`.limit(0).exists()` (now `true` when rows exist, rather than `true` when they do not).

### Gap 2 of 3: "not ready" versus "not there" (R2)

Option (a): document the carve-out and keep the `null`. Rejected — the whole premise is that this
distinction must not be silently lost, and a doc note does not restore it to the caller.
Option (b): **do not swallow `UnresolvedContextError` on the `exists` path.**

Chose (b). `exec()`'s swallow is deliberate and stays exactly as it was — a reactive layer
re-running a SELECT is a different contract from a terminal boolean. Implemented by extracting
`exec()`'s body into a private `_run(target, swallowUnresolvedContext)` that both entry points
share, so the two behaviours sit side by side and neither can drift.

The `.for(null)` / pending-*subject* short-circuits stay `false`: "does the node with no id
exist?" is a question with a correct total answer. The where-clause case is different — there the
query itself could not be formed.

### Gap 3 of 3: sync throw past a promise contract (R3)

`static exists` is now `async`, which converts any synchronous throw in builder assembly into a
rejection. One keyword; no behavioural change other than the one intended.

## Iteration 1 — Plan

- `src/queries/QueryBuilder.ts` — extract `exec()` → `_run(target, swallowUnresolvedContext)`;
  `exists()` becomes `async`, adds `offset: undefined` to the cleared set, calls `_run(target, false)`.
  TSDoc rewritten: an explicit dropped/kept list, the `OFFSET` rationale, and the precise boundary
  between "rejects" and "resolves false".
- `src/shapes/Shape.ts` — `static async exists`; TSDoc corrected on `PendingQueryContext` and on
  malformed string IRIs.
- Tests — add `existsPaginated` fixture; new assertions for pagination-dropped (IR, golden and live
  Fuseki with a genuinely multi-row projection), `minus` retained, `.forAll().exists()`,
  `.limit(0)`, unresolved-context rejecting *while `exec()` still resolves null*, and no synchronous
  throw. Make the destructive Fuseki test restore its dataset in a `finally`.

## Iteration 1 — Phases

### Phase 5 — apply R1–R4 — **done**

- [x] `_run` extraction, `exists()` drops pagination, both entry points `async`.
- [x] TSDoc corrected on both methods.
- [x] 15 new/strengthened tests.

**Validation:** `npm test` → **67 suites, 1654 passed / 120 skipped**, typecheck clean.
(Baseline before this work: 1626 passed.)
