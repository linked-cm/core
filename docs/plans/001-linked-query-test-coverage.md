---
summary: Expand the hand-written linked-query E2E suite (queries + seed data) to cover features core supports but currently leaves untested, exercised through the live-query/store contract.
status: Review
source: docs/linked-query-test-coverage.md
---

# Linked-query test coverage expansion

## Context

`src/tests/sparql-fuseki.test.ts` runs 77 of 132 fixtures from
`query-fixtures.ts` against the Fuseki `Person/Employee/Dog/Pet` graph. The full
gap analysis is in `docs/linked-query-test-coverage.md`. The recent dev merge
flipped the contract: **IR is an internal detail**, datasets receive the live
query and lower internally (`SparqlDataset.selectQuery(query)` →
`lower(query)`), and **DSL-JSON** (`toJSON`/`fromJSON`) + **`{$ctx}`** context
references are now first-class. This plan turns the gap analysis into an
implemented, committed test expansion written against that contract.

## Architecture decisions

1. **New test file `src/tests/sparql-fuseki-coverage.test.ts`** (matches the
   `sparql-fuseki` pattern used by `npm run test:fuseki`). Keeps the existing
   2,100-line suite untouched and the diff reviewable. It owns an **extended
   seed** = the existing `Person/Employee/Dog/Pet` triples **+** a new `Metric`
   block **+** a few extra `Person` edges (for property paths). It manages the
   shared `nashville-test` dataset with `clearAllData → loadTestData` in
   `beforeAll` and `clearAllData` in `afterAll`, so it is order-independent of
   the existing file under `--runInBand`.
2. **Result assertions go through the store contract.** Build a DSL query and
   run it via `new FusekiStore(...).selectQuery(query)` / `createQuery` /
   `updateQuery` / `deleteQuery`. The store lowers internally. Golden/IR-string
   checks (`captureQuery` → `lower` → `selectToSparql`) are used only where
   pinning exact SPARQL is the point (existing golden files).
3. **Additive-only changes to `query-fixtures.ts`.** Add a new `Metric` shape +
   property refs and new fixtures; **do not modify** existing
   `Person/Employee/Dog/Pet` shapes or existing fixtures — that keeps every
   `ir-*` / `sparql-*-golden` snapshot valid.
4. **Separate `Metric` shape** (decision 3B) for datatype coverage; single-valued
   `score:decimal, rating:double, views:long, count:integer, joinedOn:date`
   **plus** one multi-valued numeric field `scores: decimal[]`.
5. **Phase ordering**: §1 (wire unexecuted fixtures) lands first and is validated
   with `npm run test:fuseki` before later phases. Aggregates are out (backlog
   002); only `count` is tested.

## Scope → what each area adds

- **§1 — Wire 55 unexecuted fixtures** (MINUS, bulk/conditional mutations,
  expression WHERE, negation/quantifier, computed projections, expression
  updates, deep nesting). Groups 1–6 are SOUND → straight exact-result tests via
  the store. The deep-nesting group (15) is RISKY → **investigate-first spike,
  then fix surfaced bugs immediately** (decision 2A; pause + report only if a fix
  balloons). A couple need extra seed (e.g. `whereExprStrlen` needs a name > 5
  chars; `updateExprCallback` needs a `Dog` `d1` with `guardDogLevel`).
- **§2 — Operators** (all verified to lower correctly): string
  (`concat/contains/startsWith/endsWith/substr/replace/matches/before/after`),
  numeric (`minus/times/divide/abs/round/ceil/floor/power`), date components
  (`year/month/day/hours/minutes/seconds`), null/conditional
  (`isDefined/isNotDefined/defaultTo/Expr.ifThen`), comparison (`gte/lte`), RDF
  introspection (`str/datatype/iri/isLiteral/isNumeric`), hashes (`md5`,
  `sha256` — exact digest of a seed literal; skip `sha512`). Each as a filter
  and/or projection fixture with an exact expected value.
- **§3 — Datatypes** via `Metric`: assert JS coercion (`decimal/double/long/
  integer` → `number`, `date` → `Date`), negative-number round-trip, and the
  **multi-valued numeric** field's array collection + dedup + ordering.
- **§4 — DSL property paths E2E**: shapes whose decorator path is
  `{seq|inv|alt|oneOrMore|zeroOrMore|zeroOrOne}` used in `Shape.select(...)`,
  asserting mapped results against a seeded chain (today only golden/raw-SPARQL).
- **§5 — Builder features**: multi-key `orderBy`, mixed ASC/DESC, `orderBy` on a
  nested path, **top-level `offset`** windowing, `.as(Shape)` casting through a
  traversal. (`SelectBuilder` is the renamed builder.)
- **§6 — DSL-JSON round-trip E2E**: for a representative select + each mutation,
  `store.selectQuery(fromJSON(q.toJSON()))` equals `store.selectQuery(q)`; assert
  the wire envelope carries `v` and `op`. (Currently only unit round-trip tested.)
- **§7 — `{$ctx}` E2E**: `getQueryContext('user')` as select subject, update
  target, mutation field value, delete id, and where-arg; delete-by-context
  (`Person.delete(getQueryContext('user'))`); `UnresolvedContextError` when a
  mutation's context is unset at lowering; select resolves to `null` when unset.

## Files expected to change

- `src/test-helpers/query-fixtures.ts` — **add** `Metric` shape + property refs;
  **add** new operator / datatype / property-path / builder fixtures. Additive
  only.
- `src/tests/sparql-fuseki-coverage.test.ts` — **new**. Extended seed + all
  §1–§7 store-contract result assertions.
- `src/tests/sparql-select-golden.test.ts` — optional, only where a new operator
  warrants an exact-SPARQL pin.
- Bug-fix targets if the §1 deep-nesting spike fails — most likely
  `src/sparql/resultMapping.ts` (nested grouping) and/or
  `src/queries/IRLower.ts` / `IRProjection.ts`. Unknown until the spike.
- `docs/plans/001-...md` — updated after each phase.

## Inter-component contracts (already in code; tests depend on them)

```ts
// Store contract (src/sparql/SparqlDataset.ts) — receives the LIVE query
store.selectQuery(query: SelectQuery): Promise<ResultRow[] | ResultRow | null>
store.createQuery(query: CreateQuery): Promise<{id: string} & Record<string,unknown>>
store.updateQuery(query: UpdateQuery): Promise<{id: string} | void>
store.deleteQuery(query: DeleteQuery): Promise<{count: number; deleted: {id:string}[]}>

// DSL-JSON (src/queries: fromJSON.ts / lower.ts)
fromJSON(query.toJSON())            // DSL-JSON → live query (op-detected, carries v)

// Context (src/queries/QueryContext.ts + ContextRef.ts)
setQueryContext('user', {id}, Person); getQueryContext('user')  // → {$ctx:'user'}
// mutations throw UnresolvedContextError when unresolved at lower() time

// Seed-data URI contract (src/shapes/SHACL.ts:629, :930)
shapeURI  = `https://linked.cm/shape/core/${ShapeName}`         // e.g. .../Metric
propURI   = `${shapeURI}/${propertyLabel}`                       // e.g. .../Metric/score
```

Example (representative new test):

```ts
const store = new FusekiStore(FUSEKI_BASE_URL, 'nashville-test');

// §3 datatype coercion
const m = await store.selectQuery(Metric.select(x => [x.score, x.joinedOn]).for(entity('m1')));
expect(typeof m.score).toBe('number');
expect(m.joinedOn).toBeInstanceOf(Date);

// §6 DSL-JSON round-trip equivalence
const q = Person.select(p => [p.name, p.friends.name]);
expect(await store.selectQuery(fromJSON(q.toJSON())))
  .toEqual(await store.selectQuery(q));

// §7 context-bound select (user = p3)
const r = await store.selectQuery(Person.select(p => p.name).where(p => p.bestFriend.equals(getQueryContext('user'))));
```

## Potential pitfalls

- **Don't touch `Person`'s rows/shape** — golden snapshots will churn. New data
  goes on `Metric`/new entities and new edges only.
- **Shared dataset**: both Fuseki files use `nashville-test`; rely on
  beforeAll/afterAll clear+load and `--runInBand` ordering.
- **`whereExprStrlen`** needs a name > 5 chars in the seed (current names ≤ 5).
- **Hash tests**: compute expected `md5`/`sha256` in JS from the literal's
  lexical form; keep the hashed field a plain/`xsd:string` literal.
- **`power`** unrolls to repeated multiplication — assert the number, not SPARQL.
- **Multi-valued numeric** dedup is by string form; assert a sorted array.
- **Known limitations to exclude from exact-result scope**:
  `customResultEqualsBoolean` (boolean not projected) and `whereWithContextPath`
  (documented tautology) — leave as-is or assert current behavior only.
- **Language tags** out of scope.

## Architecture compliance

- `npx semantu-agents docs architecture` returns nothing and `docs/architecture/`
  does not exist (the private `semantu-agents` skills were not fetched — no git
  access). **No architecture docs to comply with.** The design follows the
  documented query contract instead: `documentation/dsl-json.md` and the dev
  changeset `.changeset/dataset-contract-and-dsl-json.md` (live-query/store
  contract, IR internal). New tests use only public exports (`lower`, `fromJSON`,
  `getQueryContext`, the `Shape` DSL, `FusekiStore`/`SparqlDataset`).

## Test strategy

- **Impacted package**: root `@_linked/core` only.
- **Quick regression gate after each phase (~1–2 min, no Docker)** — catches
  fixture/golden regressions from `query-fixtures.ts` edits:
  `npx jest --config jest.config.js --runInBand --testPathPattern='ir-|sparql-.*-golden|serialization|field-set|query-builder|lower|mutation-serialization'`
- **Fuseki gate after each phase** (validates the new E2E tests; required before
  continuing past §1): `npm run test:fuseki` (brings up docker Fuseki, runs the
  `sparql-fuseki` pattern incl. the new file, tears down).
- **Full suite deferred to review**: `npm test`.
- **Command sources**: `package.json` scripts (`test`, `test:fuseki`).
- **Skip/defer rationale**: the full suite and Docker-backed Fuseki run are
  slower; the quick golden gate is the fast inner loop, Fuseki runs per phase.

## Ideation findings (explored)

- **Aggregates `sum/avg/min/max`: NOT reachable from the DSL** (only `count`).
  IR + SPARQL support them generically; deferred to backlog 006.
- **Property paths through the DSL: pipeline sound E2E**, but no result-asserting
  test exists yet.
- **All untested operators lower to valid SPARQL** — none broken (`power`
  unrolls by design).
- **Fixture soundness**: MINUS, bulk/conditional mutations, expression WHERE,
  negation/quantifier, computed projections, expression updates = SOUND; the 15
  deep-nesting sub-selects = RISKY (no golden SPARQL, only type tests).
- **DSL-JSON + `{$ctx}`** tested only at unit/round-trip level — never against
  Fuseki.

## Accepted decisions

- All five original categories in scope + DSL-JSON round-trip + `{$ctx}`. §1
  first, validated via `npm run test:fuseki` before later phases.
- Result assertions through the store/`IDataset` contract; golden only where
  pinning SPARQL fits. New code uses `SelectBuilder`/`lower()`/`IR*` names.
- Separate `Metric` shape (single-valued typed fields + one multi-valued numeric
  field); existing `Person` graph extended only with new edges.
- Assert exact results; mutations run against the throwaway test graph.
- Language tags out of scope.
- Aggregates `sum/avg/min/max` deferred → backlog 006 (count only here).
- Deep-nesting RISKY group: investigate-first, then fix surfaced bugs
  immediately; pause + report only if a fix truly balloons.

## Open questions / unclear areas

- Exact pass rate of the 15 deep-nesting fixtures is unknown until the §1 spike;
  the size of any fix is therefore unbounded until then (mitigated by the
  pause-and-report rule).
- Whether any new operator deserves a golden-SPARQL pin in addition to the
  result assertion (decide per-operator during implementation).

## Phases / tasks

Validation gates per phase:
- **G-fast** (~1–2 min, no Docker): `npx jest --config jest.config.js --runInBand
  --testPathPattern='ir-|sparql-.*-golden|serialization|field-set|query-builder|lower|mutation-serialization'`
  — guards against fixture/golden regressions from `query-fixtures.ts` edits.
- **G-e2e**: `npm run test:fuseki` — the new file's tests must **actually execute**
  (Fuseki up) and pass exact-result assertions. (Local Fuseki is run from the
  Apache Jena 5.5.0 standalone distribution; the docker image host is
  egress-blocked.)

Each phase = one commit (tests + updated plan doc).

### Phase 1 — Scaffolding + §1 SOUND groups  *(blocks all later phases)*  ✅ DONE
- New `src/tests/sparql-fuseki-coverage.test.ts`: extended seed (existing graph +
  `p5` long name + `d1` Dog) + `FusekiStore` harness (skip-if-no-Fuseki).
- Wired SOUND fixtures with exact assertions: MINUS (7), negation/quantifier (5),
  expression WHERE (7 selects + `whereExprUpdateBuilder`/`whereExprDeleteBuilder`),
  computed projections (3), expression updates (`updateExprCallback`,
  `updateExprNow`), bulk/conditional mutations (`updateForAll`, `updateWhere`,
  `deleteWhere`, `deleteAll`, `deleteAllBuilder`).
- **Result: 31 passing, 2 skipped.**
- **Bugs surfaced** (→ `docs/backlog/003`): `exprNestedPath` (SELECT alias
  collision → 400), `updateExprTraversal` + `updateExprSharedTraversal` (UPDATE
  expression-over-traversal is unscoped → silent data corruption). Quarantined
  (skip); decision pending (fix now vs. defer) — likely-to-balloon mutation fix.
- **Validation**: G-e2e green (31/31 non-skipped pass against standalone Fuseki).
- Local Fuseki: Apache Jena 5.5.0 standalone (docker image host egress-blocked);
  run via `bash /home/user/fuseki-dist/run-fuseki-tests.sh '<pattern>'`.

### Phase 2 — §1 deep-nesting RISKY group (spike → fix)  ✅ DONE (with backlog)
- Spiked all 14 deep-nesting fixtures through the store. **11 are correct** →
  landed as exact tests. **3 surfaced bugs** → quarantined (`test.skip`) and
  documented in `docs/backlog/004`:
  - `pluralFilteredNestedSubSelect` — inline `.where()` on a plural sub-select
    dropped.
  - `subSelectWithCount` — nested aggregate mis-scoped to the parent row.
  - `subSelectWithOne` — null-property friend dropped under `.one()`.
- **Ballooning flag (per decision 2A):** these 3 + backlog 003's 2 update bugs =
  5 core lowering bugs. Fixing nested-projection/mutation internals is a separate
  correctness effort, not test authoring — left backlogged rather than fixed here.
- **Result so far: 43 passing, 5 skipped.**

### Phase 3 — §3 datatypes (`Metric` shape)  ✅ DONE
- Added `Metric` shape to `query-fixtures.ts` + seed (`m1`, `m2`).
- Tests pass: decimal/double/long/integer → JS number, `xsd:date` → Date,
  negative round-trip, multi-valued numeric dedup → number[]. No golden
  regression (G-fast 605 pass). **47 passing, 5 skipped.**

### Phase 4 — §2 operators  ✅ DONE
- Exact tests pass: string (`substr/replace/concat/before/after/contains/
  startsWith/endsWith/matches`), numeric (`minus/times/divide/power/abs/round/
  ceil/floor/gte/lte`), date (`year/month/day`), `isDefined`, `defaultTo`,
  `str`, `datatype`, and `md5`/`sha256` (exact digests).
- **2 bugs quarantined** (→ `docs/backlog/005`): `isNotDefined` (property
  inner-joined, never matches) and `Expr.ifThen` (returns else-branch when the
  condition is true).
- **57 passing, 7 skipped.**

### Phase 5 — §4 DSL property paths E2E  ✅ DONE
- Added `PathNode` shape (sequence `knows/name`, alternative `email|phone`,
  inverse+sequence `^knows/name`, transitive `manages+/name`) + seed chain.
- All 4 lower end-to-end through `Shape.select` and return correct results.
  No golden regression. **61 passing, 7 skipped.**

### Phase 6 — §5 builder features  ✅ DONE
- `orderBy DESC`, multi-key `orderBy [hobby, name]`, top-level `offset`+`limit`
  windowing — all pass with exact ordering.

### Phase 7 — §6 DSL-JSON round-trip E2E  ✅ DONE
- select round-trips losslessly (`v:'1.0'`, identical results); create and update
  round-trip via `fromJSON(q.toJSON())` and execute correctly.

### Phase 8 — §7 `{$ctx}` E2E  ✅ DONE
- Context as select subject (→p3) and where-arg (→p2); delete-by-context removes
  p3; a mutation with an unresolved context rejects. **71 passing, 7 skipped.**

### Dependency graph / parallelization
- **Phase 1 blocks everything** (creates the file + harness + base seed).
- **Phase 3 → Phase 4** (numeric/date operators need `Metric`).
- Phases **2, 5, 6, 7, 8** depend only on Phase 1 and are mutually independent
  (parallelizable in principle; executed sequentially here, each gated).

## Review

**Outcome:** all 8 phases implemented. `src/tests/sparql-fuseki-coverage.test.ts`
adds **71 passing E2E tests + 7 quarantined (skip)**, all through the live-query
store contract. **Full suite: 1269 passed, 0 failed, 121 skipped** (no
regressions). One core bug fixed (`exprNestedPath` alias collision).

### Coverage delivered
- §1 MINUS, negation/quantifier, expression-WHERE, computed projections,
  expression updates, bulk/conditional mutations, 11/14 deep-nesting sub-selects.
- §2 operators: string, numeric, date, `isDefined`/`defaultTo`, `str`/`datatype`,
  `md5`/`sha256` (exact digests).
- §3 datatype coercion (decimal/double/long/integer/date + multi-valued numeric).
- §4 DSL property paths (sequence/alternative/inverse/transitive) E2E.
- §5 builder: orderBy DESC/multi-key, top-level offset windowing.
- §6 DSL-JSON round-trip (select/create/update).
- §7 `{$ctx}` subject/where-arg/delete-by-context/unresolved-rejection.

### Bugs surfaced (quarantined, backlogged) — gaps for a follow-up cycle
- backlog 003: `updateExprTraversal` / `updateExprSharedTraversal` (UPDATE
  expression-over-traversal unscoped → data corruption). **High priority.**
- backlog 004: `pluralFilteredNestedSubSelect` (filter dropped),
  `subSelectWithCount` (nested aggregate mis-scoped), `subSelectWithOne`
  (null-property row dropped under `.one()`).
- backlog 005: `isNotDefined` (never matches), `Expr.ifThen` (wrong branch).
- backlog 006: `sum`/`avg`/`min`/`max` not reachable from the DSL (count only).

### Remaining coverage gaps (not bugs — candidates for an iteration)
- Operator tail not yet asserted: `hours/minutes/seconds`, `encodeForUri`,
  `iri`/`isLiteral`/`isNumeric`/`isBlank`, `zeroOrMore`/`zeroOrOne` paths.
- `{$ctx}` as update-target and mutation field value (subject/where/delete done).
- DSL-JSON delete round-trip (select/create/update done).
- Boolean expression projection (`customResultEqualsBoolean`) — known limitation.

### Environment note
Local Fuseki runs from the Apache Jena 5.5.0 standalone distribution (the docker
image registry host is egress-blocked). Helper: `bash
/home/user/fuseki-dist/run-fuseki-tests.sh '<jest-pattern>'`. This is local-only
scaffolding, not committed to the repo.

## Iteration 1 — bug fix + coverage tails

Selected after the review pause: fix the high-priority data-corruption bug and
close the coverage tails.

### Gap 1 — backlog 003 Bug 2 (UPDATE expression-over-traversal) — FIXED
`updateToAlgebra` now nests each traversal-anchored leaf property triple as an
OPTIONAL inside its traversal-edge group (instead of flat LEFT JOINs applied
before the edge). The target var is scoped to the subject's traversal target, so
an absent edge no longer matches every entity, and a missing optional property
no longer drops sibling fields. `updateExprTraversal` / `updateExprSharedTraversal`
un-quarantined with positive (target-with-bestFriend) and no-corruption tests.

### Gap 2 — coverage tails — ADDED
- Operators: `hours`/`minutes`/`seconds` (timed birthDate), `encodeForUri`,
  `isLiteral`/`isNumeric` (filters).
- Property paths: `zeroOrMore` (`knows*`) and `zeroOrOne` (`knows?`) via two new
  `PathNode` properties.
- DSL-JSON: delete round-trip via `fromJSON` (deleteWhere).
- `{$ctx}`: update-target and mutation field-value.

### Result
**82 passing, 5 skipped** in the coverage suite; **full suite 1433 passed, 0
failed**. Remaining skips are backlog 004 (nested sub-select: 3) and backlog 005
(operators: 2). Bug 1 (`exprNestedPath`) and backlog 003 are now fixed.

## Iteration 2 — backlog 005 operator bugs

Fixed the two operator-lowering bugs (2 of the 5 remaining skips).

### Bug 6 — `isNotDefined` never matches — FIXED
`collectRequiredBindingKeys` (`src/sparql/irToAlgebra.ts`) treated `BOUND`'s
argument as a required binding, inner-joining the property and making
`FILTER(!BOUND(?x))` unsatisfiable. `BOUND` now contributes no required keys, so
the property stays OPTIONAL. `isDefined` results are unchanged (the positive
filter enforces boundness itself). Residual noted in backlog 005: `COALESCE`/`IF`
args in a where-filter are still marked required (same family, no failing test yet).

### Bug 7 — `Expr.ifThen` wrong branch — FIXED (diagnosis revised)
Not branch inversion: `Expr.ifThen`/`Expr.firstDefined`/`Expr.concat` dropped
their arguments' proxy-trace `_refs` maps when constructing `ExpressionNode`
directly, leaving `__ref_N__` placeholder aliases unresolved — the condition's
property pattern became an unconstrained cross-product over all entities. The
three functions now merge arg refs (`mergedRefs` in `src/expressions/Expr.ts`),
matching `_derive` semantics.

### Result
**84 passing, 3 skipped** in the coverage suite (both 005 tests un-quarantined
with exact-result assertions); **full suite 1435 passed, 0 failed**. Remaining
skips are the backlog 004 nested sub-select trio.

## Iteration 3 — backlog 004 nested sub-select bugs

Fixed the last three quarantined bugs.

### Bug 3 — dropped inline `.where()` on a plural sub-select — FIXED
`.where(...).select(...)` lost the filter: `forSubSelect` never captured the
source chain's `wherePath`. Now carried via `parentWherePath`/`Index` on the
FieldSet and mapped to `entry.scopedFilter` (`FieldSet.ts`, `SelectQuery.ts`).
Fixing that exposed a second defect: children of a filtered traversal (nested
sub-select traversals + projected property triples) were emitted as top-level
OPTIONALs — a cross-product when the filter matched nothing. They now nest
inside the filtered block (`irToAlgebra.ts` §5b). DSL-JSON round-trip verified.

### Bug 4 — nested aggregate mis-scoped — FIXED
SPARQL was already per-friend; the result mapper anchored `aggregate_expr` at
the root. Now anchored to the aggregate argument's `sourceAlias`
(`resultMapping.ts`).

### Bug 5 — `.one()` truncates plural sub-rows — FIXED (diagnosis revised)
Not a null-property join issue: `.one()`'s `LIMIT 1` bounds rows, and one
entity spans N rows when traversals/plural properties are projected. LIMIT is
now omitted for `singleResult` queries that yield multiple rows per entity; the
mapper picks the single entity (`irToAlgebra.ts`). Flat `.one()` keeps LIMIT 1.

### Result
**87 passing, 0 skipped** in the coverage suite — no quarantined tests remain;
**full suite 1438 passed, 0 failed**. All 7 bugs surfaced by this plan's
coverage work (backlog 003/004/005) are fixed. Residuals documented in backlog
004 (nested filtered-inside-filtered traversals) and 005 (COALESCE/IF args in
where-filters marked required).

### Addendum — backlog 004 residual fixed
New fixture `nestedFilteredSubSelects` (outer `.where(name='Moa')`, inner
`.where(name='Jinx')`) reproduced the cross-product: the inner filtered block
was emitted at top level with a potentially-unbound subject alias. Fixed in
`irToAlgebra.ts` §5b (two-pass block assembly; child filtered blocks nest
inside their parent's block). Coverage suite now **88 passing**; full suite
**1440 passed, 0 failed**. Remaining known residual: backlog 005 COALESCE/IF.

### Addendum — backlog 005 residual fixed
Probing confirmed both forms were DSL-reachable with silent wrong results:
`p.hobby.defaultTo('none').equals('none')` in a where returned `[]` (hobby
inner-joined, fallback unreachable), and `Expr.ifThen(...)` in a where
inner-joined its branch properties. Fixed `collectRequiredBindingKeys`:
COALESCE contributes no required keys; IF keeps only its condition's keys.
New fixtures `whereExprDefaultTo`/`whereExprIfThen` + E2E tests (exact ids).
Coverage suite **90 passing**; full suite **1444 passed, 0 failed**. Last
noted limitation (unchanged, errors loudly rather than silently): a bare proxy
property as an `Expr.*` argument throws `Invalid expression input`.
