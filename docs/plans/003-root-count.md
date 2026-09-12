---
summary: >
  A root-level COUNT in the query DSL — `SelectBuilder.from(shape).where(…).count()`, resolving to a
  real `number` and lowering to `SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { … }`. A sibling
  builder modelled on `ask`, so `limit`/`offset` are unrepresentable rather than ignored.
status: Implementation
packages: [core]
consumers: ["@_linked/shape-ui — selectInstances({limit, offset}) + withTotal server-side paging"]
---

# 003 — Root-level `COUNT`

"How many instances of this shape match this filter?" is today unanswerable in the DSL. The only
count that exists is `size()` on a **property's value set** (`p.friends.size()`), which counts per
row and requires a `subject.property`. A table that pages server-side needs the total of the match
set, independent of the page it is showing.

## Planning blockers explored

### B1 — Can a root count ride on `IRSelectQuery` with an aggregate projection? **No.**

`selectToAlgebra` (`src/sparql/irToAlgebra.ts`) does two things unconditionally:

- step 7 — `projection.push({kind: 'variable', name: rootAlias})` before any projection item is
  converted: the root alias is **always** a projected variable;
- step 8 — when any aggregate is present, *every* non-aggregate projected variable becomes a
  `GROUP BY` target.

So an `IRSelectQuery` whose only projection item is `aggregate_expr('count', …)` lowers to

```sparql
SELECT ?a0 (COUNT(?a0) AS ?count) WHERE { … } GROUP BY ?a0
```

— one row per entity, each counting 1. That is not a root count, and it is not a rounding error:
it is a *plausible-looking wrong number*. Producing the root form out of `IRSelectQuery` means a
mode flag that has to be honoured in two separate places in one 560-line function, where forgetting
either yields a silently wrong total.

### B2 — Does the algebra/serialization layer already emit what we need? **Yes, unchanged.**

`SparqlSelectPlan` carries `projection: SparqlProjectionItem[]`, and
`{kind: 'aggregate', expression: {kind: 'aggregate_expr', name: 'count', args: [...], distinct: true}, alias}`
already serializes as `(COUNT(DISTINCT ?a0) AS ?alias)` (`algebraToString.ts:174-180, 342-346`).
`groupBy`, `limit`, `offset`, `distinct` and `having` are all optional and omitted when unset. So the
count plan **is** a `SparqlSelectPlan`, serialized by the existing `selectPlanToSparql`, and
`algebraToString.ts` needs no change at all. Requirement 3 (reuse `aggregate_expr` and its lowering)
is met at both the IR and the algebra level.

### B3 — Is there a precedent for a root query that is not a select? **Yes — an exact one: `ask`.**

`IRAskQuery` / `AskQuery` / `AskBuilder` / `askToAlgebra` were built for precisely this class of
problem: a query whose answer is a scalar, for which projection, ordering and pagination are
meaningless. The design rule is stated in their own docs — those fields are *"unrepresentable"*
rather than ignored, so "the normalisation cannot be forgotten or half-applied". And
`askToAlgebra` reuses `selectToAlgebra` to build the pattern and discards its projection, so shape
scans, traversals, filters and `MINUS` keep exactly one implementation.

A count is the same shape of thing with a `number` instead of a `boolean`. Following this precedent
gives the DSL one idiom for scalar-answering queries instead of two.

### B4 — How does a count cross a process boundary?

The same way an ask does: a DSL-JSON envelope with an `op` discriminator, routed by `fromJSON`'s
existing `switch`. An older peer hits that switch's `default:` and throws
`Unknown query op "count"` — loud, not silently reinterpreted as a select. `assertWireVersion` only
rejects on a MAJOR mismatch, so `WIRE_VERSION` stays `'1.1'` (a new additive `op` is exactly what
that policy tolerates, and bumping the minor would churn every golden envelope that pins `v`).

### B5 — Can a new `IDataset` method be added in a minor? Only as an optional one.

`askQuery` is **required** on `IDataset`. A required `countQuery` would break every implementer at
compile time — unacceptable for a `minor`. Optional + a `resolveCount` helper that throws a precise,
actionable error gives the same runtime guarantee as `resolveExistence` without the break.

### B6 — `COUNT(?s)` or `COUNT(DISTINCT ?s)`? **DISTINCT.**

`selectToAlgebra` emits `SELECT DISTINCT` for every non-aggregate query, and for good reason: a
shape scan joined with property triples yields one row per property-value combination. A `where`
clause on a multi-valued property therefore produces several rows per subject. Counting rows would
inflate the total for exactly the queries this feature exists to serve. `COUNT(DISTINCT ?a0)`
counts subjects, which is what "how many instances match" means.

### B7 — What does the count of a query with no subject mean?

`.for(null)` / an unresolved `PendingQueryContext` as the subject: a windowed table never does this,
but the builder can. Mirroring `exists()` (which answers `false`), `count()` answers `0` without
querying — "how many nodes with no id match?" has a correct total answer. Lowering such a query is
refused loudly, as `lowerAsk` already refuses it, because a subject-less pattern would count every
instance of the shape and report it as the count of one node.

## Decisions

Priority framework applied: (1) long-term maintainability, (2) scalability, (3) performance.

### D1 — Route: a sibling `CountBuilder` / `CountQuery` / `IRCountQuery`, modelled on `ask`

Alternatives considered:

| Route | Verdict |
|---|---|
| **A. Sibling builder + `IRCountQuery`** (chosen) | Pattern-only IR; `limit`/`offset` have nowhere to live, so requirement 2 is enforced by the *type*. One new optional `IDataset` method. |
| B. `countOnly?: boolean` on `IRSelectQuery` | No new dataset method — but B1's two lowering sites must both honour the flag, `limit`/`offset` must be *ignored* in a type that carries them, and a `ResultRow[]` result must be squeezed into a number. Exactly the "silently wrong" failure mode the ask design was written to avoid. |
| C. An option on `exec()` | Same as B, plus a result type that becomes a union and poisons `SelectBuilder`'s inference. |

**A**, on maintainability: it is the idiom this codebase already chose for this problem, proven
end-to-end (IR → algebra → SPARQL → wire → dispatch) by `ask`.

### D2 — API: `SelectBuilder.count(target?): Promise<number>`, plus `toCount()` and `Shape.count()`

- `.count(target?)` on `SelectBuilder` — the symmetric twin of `.exists(target?)`, resolving to a
  real `number`. This is the form the consumer needs: `SelectBuilder.from(shapeIri).where(…).count()`
  works from nothing but a shape IRI and a where clause.
- `.toCount(): CountBuilder` — **public** (unlike the private `_toAsk()`), because a router or RPC
  boundary needs the envelope (`toCount().toJSON()`) to forward the query rather than execute it.
  `@_linked/shape-ui`'s `withTotal` crossing an HTTP boundary is precisely that caller.
- `Shape.count(target?)` — the no-filter shorthand, mirroring `Shape.exists(id)`. On the **base
  class** it throws: a shapeless count would count every node in the store, which is never what a
  caller means (contrast `Shape.exists(uri)`, where the shapeless reading is useful and cheap).

Type-checking (requirement 4): `CountBuilder` is **non-generic** — `implements PromiseLike<number>`.
It cannot perturb `SelectBuilder<S, R, Result>`'s inference because it participates in none of it,
and `.count()` returns a plain `Promise<number>` regardless of `R`/`Result`. A type probe pins this.

### D3 — `limit`/`offset` are **dropped** at the `toCount()` boundary, then unrepresentable

Requirement 2, decided and documented: **dropped, not rejected.**

Kept: shape, subject(s), `where`, `minus` — everything that decides membership of the match set.
Dropped: projection, preloads, `orderBy`, `limit`, `offset`.

Why dropped rather than an error:

1. There is exactly one sensible interpretation. `count()` answers a question about the **match
   set**, not about a page of it — as `OFFSET` skips rows of a *solution sequence* and a count has
   none.
2. The paging caller holds **one** builder. `selectInstances(shape, {limit, offset})` wants the page
   *and* the total from the same filter; rejecting the combination would force it to rebuild the
   builder without the window, by hand, for zero correctness gain.
3. `.exists()` already made this exact call for this exact reason. Dropping keeps **one** DSL rule —
   *a scalar-answering query drops the solution-sequence modifiers* — instead of two.

The drop happens once, in `toCount()`, and cannot be half-applied: `CountQuery`, `CountQueryJSON`
and `IRCountQuery` have no field to put a window in, and `countToAlgebra` builds a plan with
`limit`/`offset`/`orderBy`/`groupBy` all undefined. A golden test asserts a paginated builder's
count is byte-identical to the bare one's.

### D4 — `COUNT(DISTINCT ?root)` — see B6. Golden-tested.

### D5 — Wire: `op: 'count'`, `WIRE_VERSION` unchanged — see B4.

### D6 — `IDataset.countQuery?` optional; `SparqlDataset.countQuery` concrete

Optional on the interface (B5), concrete on `SparqlDataset`, so every SPARQL-backed store — including
every subclass in every consumer — gets it for free with no edit. `resolveCount` in `queryDispatch`
enforces the contract once for every store, mirroring `resolveExistence`: the answer must be a
finite non-negative integer, and **a failure rejects — it is never reported as `0`.** A count that
reports an unreachable store as "0 rows" renders an empty table and looks like data.

### D7 — Result mapping: `mapSparqlCountResult`, strict

Reads the single binding for the count alias and rejects a missing binding, an empty result set, or a
non-numeric value. It does not default to `0`, for D6's reason.

## Selected route

**D1 route A**: a pattern-only `IRCountQuery` and a non-generic `CountBuilder`, both modelled
one-for-one on the existing `ask` pipeline; `countToAlgebra` reuses `selectToAlgebra` for the pattern
and the existing `aggregate_expr` node + `selectPlanToSparql` for the projection, so no new
serialization path and no second pattern implementation.

## Architecture

Six layers, each one mirroring its `ask` counterpart. The only genuinely new code is the count
projection in `countToAlgebra` (six lines) and the result reader.

```
SelectBuilder.count(target?)        ← drops projection/preloads/orderBy/limit/offset (D3)
  └─ toCount(): CountBuilder        ← public; the wire/forwarding seam
       ├─ toJSON() → {op:'count'}   ← fromJSON routes it back
       └─ exec(target?)
            └─ resolveCount(dispatch, query)        queryDispatch.ts
                 └─ IDataset.countQuery?(query)
                      └─ SparqlDataset.countQuery
                           ├─ lower(query) → IRCountQuery          lower.ts / lowerCount
                           ├─ countToSparql → countToAlgebra       irToAlgebra.ts
                           │    ├─ selectToAlgebra(…) for the PATTERN (one implementation)
                           │    └─ + {kind:'aggregate', aggregate_expr count DISTINCT ?a0}
                           │    └─ selectPlanToSparql (UNCHANGED)
                           └─ mapSparqlCountResult                 resultMapping.ts
```

Emitted form:

```sparql
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT (COUNT(DISTINCT ?a0) AS ?count)
WHERE {
  ?a0 rdf:type <…Person> .
  ?a0 <…name> ?a0_name .
  FILTER(?a0_name = "Semmy")
}
```

No `GROUP BY`, no `DISTINCT` on the SELECT (the aggregate carries it), no `ORDER BY`, no
`LIMIT`/`OFFSET` — every one of those is `undefined` on the plan `countToAlgebra` returns, and
`selectPlanToSparql` omits each when unset.

## Contracts

### `IRCountQuery` — pattern-bearing only

```ts
export type IRCountQuery = {
  kind: 'count';
  /** Required, unlike IRAskQuery's — a shapeless count would count every node in the store. */
  root: IRShapeScanPattern;
  patterns: IRGraphPattern[];
  where?: IRExpression;
  subjectId?: string;
  subjectIds?: string[];
  /** The variable the COUNT is bound to. Result mapping reads it from here. */
  alias: IRAlias;
};
```
Added to the `IRQuery` union. There is deliberately no `projection`, `orderBy`, `limit` or `offset`.

### `CountBuilder` — non-generic

`implements PromiseLike<number>, Promise<number>`. No type parameters at all, so it cannot interact
with `SelectBuilder<S, R, Result>`'s inference (requirement 4).

- `CountBuilder.of(spec: CountSpec): CountBuilder`
- `readonly __queryKind = 'count'`, `get shape(): NodeShapeData`
- `toRawInput(): RawCountInput`, `toJSON(): CountQueryJSON`, `static fromJSON(json): CountBuilder`
- `exec(target?: IDataset): Promise<number>` — `0` without querying for a null/unresolved subject
  (B7); otherwise `resolveCount`.

### `SelectBuilder`

- `count(target?: IDataset): Promise<number>` — `this.toCount().exec(target)`.
- `toCount(): CountBuilder` — keeps shape, subject(s), `where`, `minus`; drops the rest (D3).
  A live `PendingQueryContext` subject survives as itself (same reason as `_toAsk`: narrowing it to
  `{id}` would resolve it against *this* process's context map).

### `Shape.count(target?): Promise<number>`

On a shape subclass: total instances. On the base class: **throws** — a shapeless count would count
every node in the store, and no caller means that.

### `resolveCount(target, query)` — the contract, enforced once for every store

- `countQuery` missing → throw naming the method and what to implement.
- answer must be a **finite, non-negative integer**; anything else throws rather than being coerced.
- **failures reject. A count never reports an unreachable store as `0`** — a `0` renders an empty
  table and is indistinguishable from real data. This is the count analogue of `resolveExistence`'s
  "could not ask is never `false`".

### Wire

```json
{"v": "1.1", "op": "count", "shape": "https://linked.cm/shape/core/Person",
 "where": {"name": "Semmy"}}
```

`shape` is **required** (unlike ask's). No `fields`, `limit`, `offset`, `sortBy` or `one` — a receiver
has nothing to ignore. `WIRE_VERSION` unchanged (B4).

### Known limitation (deliberate, loud)

A `where` clause containing an **aggregate** (`p.friends.size().gt(2)`) lowers to `HAVING` +
`GROUP BY` on the select plan. `countToAlgebra` takes only the plan's `algebra`, so the HAVING would
be dropped — a wrong number. Counting a HAVING-filtered group set needs
`SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { SELECT ?a0 WHERE {…} GROUP BY ?a0 HAVING(…) }`, and
`SparqlSubSelect` has no `groupBy`/`having` fields today. So `countToAlgebra` **detects the HAVING
and throws**, naming the limitation. Deferred, not silently wrong.

(Note: `askToAlgebra` has this same silent drop *without* the guard — a pre-existing bug, out of
scope here. Reported in the PR body.)

## Expected file changes

| File | Change |
|---|---|
| `src/queries/IntermediateRepresentation.ts` | + `IRCountQuery`, added to `IRQuery` |
| `src/queries/CountQuery.ts` | **new** — `CountQuery`, `RawCountInput`, `CountQueryJSON` |
| `src/queries/CountBuilder.ts` | **new** — `CountBuilder`, `CountSpec`, `isCountQuery` |
| `src/queries/QueryBuilder.ts` | + `count(target?)`, + `toCount()` |
| `src/queries/lower.ts` | + `LowerableCount`, `lowerCount`, overload + switch arm |
| `src/queries/queryDispatch.ts` | + optional `countQuery` on `QueryDispatch`, + `resolveCount` |
| `src/queries/fromJSON.ts` | + `case 'count'` |
| `src/interfaces/IDataset.ts` | + optional `countQuery?` |
| `src/shapes/Shape.ts` | + `static count()` |
| `src/sparql/irToAlgebra.ts` | + `countToAlgebra`, `countToSparql` |
| `src/sparql/resultMapping.ts` | + `mapSparqlCountResult` |
| `src/sparql/SparqlDataset.ts` | + `countQuery` |
| `src/sparql/index.ts`, `src/index.ts` | exports |
| `src/test-helpers/query-fixtures.ts` | + `countFactories` |
| `src/test-helpers/query-capture-store.ts` | + `countQuery` capture |
| `src/tests/sparql-count-golden.test.ts` | **new** — IR + SPARQL golden, DISTINCT, window invariance |
| `src/tests/count-wire.test.ts` | **new** — envelope roundtrip, `fromJSON` routing, dispatch contract |
| `src/tests/sparql-fuseki.test.ts` | + real counts against seeded data |
| `src/tests/type-probe-count.ts` | **new** — inference probe |
| `.changeset/*.md` | minor |

`src/sparql/algebraToString.ts` is deliberately **not** in this list.

## Pitfalls

1. **`selectToAlgebra` always projects the root** (B1). `countToAlgebra` must take only `algebra` from
   its result and build its own projection — never append to the returned projection.
2. **`COUNT` without `DISTINCT` counts rows, not subjects** (B6). A `where` on a multi-valued property
   inflates it. Golden-test the DISTINCT.
3. **The HAVING drop** — guard it, or a count with an aggregate filter is silently wrong.
4. **`resolveCount` must not coerce.** `Number(undefined)` is `NaN`; `NaN || 0` is `0`. Never write
   that. A non-number rejects.
5. **`PendingQueryContext` must survive `toCount()` as itself**, not be narrowed to `{id}`.
6. **`query-capture-store` needs a `countQuery` arm**, or count fixtures capture `undefined` and the
   golden tests fail confusingly.
7. **`fromJSON`'s `default:` arm** already throws on an unknown op — do not weaken it.
8. **Optional, not required, on `IDataset` and `QueryDispatch`** (B5) — a required method is a
   breaking change and this is a `minor`.

## Phases

Dependency graph: **P1 → P2 → P3 → P4 → P5**. P1 (IR + lowering) and P2 (SPARQL) are strictly
sequential — P2's golden output is the first proof P1 is right. P3 (builder/API/wire) depends on P1's
`lowerCount`. P4 (tests) is written per-phase as each lands, and finalised as its own phase because
the Fuseki and type-probe coverage needs the whole chain. P5 is docs/changeset. No phase is
parallelisable across a single agent; within P4 the three test files are independent.

### Phase 1 — IR and lowering

1. `IRCountQuery` in `IntermediateRepresentation.ts`, added to the `IRQuery` union, with the
   doc comment stating why there is no projection/orderBy/limit/offset.
2. `src/queries/CountQuery.ts` — `CountQuery`, `RawCountInput`, `CountQueryJSON`.
3. `lower.ts` — `LowerableCount`, `lowerCount` (reusing `buildSelectQuery` for the pattern),
   overload signature, switch arm. Refuse `nullSubject` and a missing `shape`, loudly.

**Validation:** `npx tsc -p tsconfig-tests.json` clean (0 `error TS`). A scratch assertion that
`lower(countBuilder)` yields `{kind:'count', root, patterns, alias:'count'}` with no `limit`/`offset`
key — folded into P4's real tests.

### Phase 2 — SPARQL lowering and result mapping

1. `countToAlgebra(query, options): SparqlSelectPlan` — pattern from `selectToAlgebra`, own
   projection, `distinct: true` on the aggregate, everything else undefined. Throw when the
   select plan came back with a `having` (pitfall 3).
2. `countToSparql` → `selectPlanToSparql`.
3. `mapSparqlCountResult(json, query): number` — strict (D7).
4. `SparqlDataset.countQuery`; `sparql/index.ts` exports.

**Validation:** typecheck clean. Golden SPARQL string asserted byte-for-byte in P4; a `grep` proof
that `algebraToString.ts` is untouched (`git diff --stat` must not list it).

### Phase 3 — Builder, public API, wire, dispatch

1. `src/queries/CountBuilder.ts` — `CountSpec`, `of`, `toRawInput`, `toJSON`, `fromJSON`, `exec`,
   `then`/`catch`/`finally`, `isCountQuery`.
2. `QueryBuilder.ts` — `toCount()` (public) and `count(target?)`.
3. `queryDispatch.ts` — optional `countQuery` on `QueryDispatch`, `resolveCount`.
4. `IDataset.countQuery?`, `fromJSON` `case 'count'`, `Shape.count()`, `src/index.ts` exports.

**Validation:** typecheck clean. `Person.select().where(…).count()` resolves to a number against the
capture store.

### Phase 4 — Tests

1. `query-fixtures.ts` — `countFactories`: `countAll`, `countWhere`, `countById`, `countMinus`,
   `countNormalised` (projection + orderBy dropped), `countPaginated` (limit/offset dropped),
   `countMultiValuedWhere` (the DISTINCT case).
2. `query-capture-store.ts` — `countQuery` arm.
3. `sparql-count-golden.test.ts` — IR golden (no `limit`/`offset`/`projection` keys), SPARQL golden
   strings, `countPaginated`/`countNormalised` byte-identical to `countAll`/`countWhere`, no
   `GROUP BY`/`LIMIT`/`OFFSET`/`ORDER BY` in any fixture's output, HAVING guard throws.
4. `count-wire.test.ts` — `toJSON` shape, `fromJSON(json)` returns a `CountBuilder` and round-trips to
   identical IR, unknown-op still throws, `resolveCount` rejects a missing method / a non-number /
   a negative / a non-integer, and **rejects rather than returning 0** when the store throws.
5. `sparql-fuseki.test.ts` — real counts against the seeded dataset, including that a count with a
   multi-valued-property filter equals the number of distinct subjects (not rows), and that a
   count ignores a window.
6. `type-probe-count.ts` — `count()` is `Promise<number>` regardless of the builder's `R`/`Result`;
   `toCount()` is a `CountBuilder`; `await countBuilder` is a `number`.

**Validation:** full Jest suite, reporting exact passed/failed. Fuseki suites run with `--runInBand`
(they share a dataset per worker). `npm run typecheck` clean.

### Phase 5 — Docs and changeset

Plan doc → `status: Implementation` with per-phase notes; `.changeset/` minor entry.

**Validation:** changeset file present and well-formed; `git status` shows nothing unintended.

## Progress

### Phase 1 — IR and lowering ✅

`IRCountQuery` (added to `IRQuery`), `CountQuery.ts` (`CountQuery`, `RawCountInput`,
`CountQueryJSON`), `lowerCount` + `COUNT_ALIAS` + the `lower()` overload and switch arm.
Both refusals in place (`nullSubject`, missing `shape`). **Validation:** `tsconfig-tests`
typecheck — 0 `error TS`.

### Phase 2 — SPARQL lowering and result mapping ✅

`countToAlgebra` (pattern from `selectToAlgebra`, own aggregate projection, `distinct: true`,
HAVING guard), `countToSparql`, `mapSparqlCountResult`, `SparqlDataset.countQuery`, exports.
**Validation:** typecheck 0 errors; `git diff --stat -- src/sparql/algebraToString.ts` empty, as
B2 predicted — the serialization layer needed no change.

### Phase 3 — Builder, public API, wire, dispatch ✅

`CountBuilder` (non-generic), `SelectBuilder.count()` / `.toCount()`, `resolveCount`, optional
`countQuery` on `QueryDispatch` and `IDataset`, `fromJSON` `case 'count'`, `Shape.count()`,
`src/index.ts` exports. **Validation:** typecheck 0 errors.

### Phase 4 — Tests ✅

`countFactories` (7 fixtures), a `countQuery` arm on the capture store,
`sparql-count-golden.test.ts` (19 tests), `count-wire.test.ts` (27 tests), 7 Fuseki tests, and
`type-probe-count.ts`.

**Validation — real numbers.** Baseline on `dev`: 1817 passed / 1938 total (the one failure in a
parallel run is the known Fuseki-suite collision that `--runInBand` avoids; serially, 200/200).
After: **1871 passed, 0 failed, 120 skipped, 1991 total** across 76 suites. `npm run typecheck`:
0 `error TS`. `npm run build`: exit 0.

The type probe was verified to *discriminate*: asserting `exists()` (a `Promise<boolean>`) against
the `Promise<number>` probe produces `error TS2345`, so a regression in `.count()`'s type would
fail the build rather than pass silently.

Fuseki **is** runnable in this environment (Docker up; the suite's own
`docker-compose.test.yml` brings up Fuseki on `:3939` via `ensureFuseki`), so the count has real
end-to-end coverage — including `SparqlDataset.countQuery`, `Person.count(store)` and a
demonstration that stripping `DISTINCT` from the emitted query changes the answer from 1 to 2.

### Phase 5 — Docs and changeset ✅

`.changeset/root-level-count.md` (minor).
