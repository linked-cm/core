---
summary: Added a 90-test E2E coverage suite exercising linked-query features through the live-query/store contract, and fixed 9 correctness bugs it surfaced in SPARQL lowering, expression construction, and result mapping — 0 skipped tests remain.
---

# Linked-query test coverage expansion + lowering bug fixes

## Context

`src/tests/sparql-fuseki.test.ts` ran 77 of 132 hand-written fixtures in
`query-fixtures.ts` against a Fuseki `Person/Employee/Dog/Pet` graph. A gap
audit found: 55 fixtures written but never executed against seed data (only
golden/IR-string tested); ~50 of 61 expression/filter operators untested;
datatype coverage limited to integer/boolean/dateTime/string; property paths
(`seq`/`inv`/`alt`/`oneOrMore`/`zeroOrMore`/`zeroOrOne`) tested only via raw
SPARQL, never through the shape→IR pipeline; several builder features
(multi-key `orderBy`, top-level `offset`, DSL-JSON round-trip execution,
`{$ctx}` resolution) untested E2E.

Mid-effort, a separate dev-branch merge landed a contract change: **IR became
an internal detail**. Datasets now receive the *live query* and lower it
internally (`SparqlDataset.selectQuery(query)` → `lower(query)` →
`selectToSparql`), and **DSL-JSON** (`toJSON`/`fromJSON`) plus **`{$ctx}`**
context references became first-class wire concerns. The plan was re-anchored
on this contract before implementation: result assertions go through
`store.selectQuery/createQuery/updateQuery/deleteQuery`, not through
capturing IR directly.

## What was built

**New test file** `src/tests/sparql-fuseki-coverage.test.ts` — 952 lines, 90
tests, **0 skipped**. Separate from the existing 2,100-line
`sparql-fuseki.test.ts` (kept untouched, diff stayed reviewable). Owns an
extended seed: the existing `Person/Employee/Dog/Pet` triples plus a new
`Metric` block, a `PathNode` chain, and a few extra `Person` edges — loaded
via `clearAllData()`/`loadTestData()` in `beforeAll`, with `reloadBase()` in
`beforeEach` for tests that mutate the graph (order-independent under
`--runInBand`). All assertions run through the `FusekiStore` store contract
(`store.selectQuery(query)` etc.) — golden/SPARQL-string assertions were used
only where pinning exact SPARQL was the point.

**New shapes** in `src/test-helpers/query-fixtures.ts` (additive-only — no
existing `Person/Employee/Dog/Pet` fixture or golden snapshot touched):
- `Metric` — one field per `xsd:decimal/double/long/integer/date`, plus a
  multi-valued `scores: decimal[]` for array coercion/dedup/ordering coverage.
- `PathNode` — decorator paths exercising `seq`, `alt`, `inv+seq`,
  `oneOrMore`, `zeroOrMore`, `zeroOrOne`, seeded as a 3-node chain (`A→B→C`).

**Coverage delivered** (by original gap-analysis section):
- **§1 — 55 previously-unexecuted fixtures wired**: MINUS/exclusion (7),
  bulk/conditional mutations (`updateForAll`/`updateWhere`/`deleteWhere`/
  `deleteAll`/builders), expression-based filters (`whereExpr*`, 9),
  negation/quantifier filters (5), computed expression projections (4),
  expression-based updates (`updateExpr*`), and all 15 deep-nesting
  sub-select shapes (dedicated results grouping/array reconstruction, not
  just golden SPARQL).
- **§2 — Operators**: string (`concat/contains/startsWith/endsWith/substr/
  replace/matches/before/after`), numeric (`minus/times/divide/abs/round/
  ceil/floor/power/gte/lte`), date (`year/month/day/hours/minutes/seconds`),
  null/conditional (`isDefined/isNotDefined/defaultTo/Expr.ifThen`), RDF
  introspection (`str/datatype/encodeForUri/isLiteral/isNumeric`), hashes
  (`md5`/`sha256`, exact digest of a seed literal).
- **§3 — Datatypes** via `Metric`: JS coercion for
  decimal/double/long/integer → `number`, `xsd:date` → `Date`, negative-number
  round-trip, multi-valued numeric array dedup/ordering.
- **§4 — DSL property paths E2E** through `PathNode`: sequence, alternative,
  inverse+sequence, transitive (`oneOrMore`), `zeroOrMore`, `zeroOrOne` — all
  asserted against seeded results, not just golden SPARQL.
- **§5 — Builder features**: `orderBy DESC`, multi-key `orderBy`, top-level
  `offset`+`limit` windowing.
- **§6 — DSL-JSON round-trip E2E**: select/create/update/delete via
  `fromJSON(query.toJSON())`, asserting identical results to the direct query
  and that the wire envelope carries `v`/`op`.
- **§7 — `{$ctx}` E2E**: context as select subject, where-arg, update target,
  mutation field value, delete-by-context, and rejection on an unresolved
  context.

Deliberately out of scope: `sum`/`avg`/`min`/`max` aggregates (not reachable
from the DSL — only `count`; tracked as its own feature-work backlog, see
below), language-tagged literals, and the known `customResultEqualsBoolean`
limitation (boolean not projected).

## Bugs found and fixed

The coverage work surfaced 9 correctness bugs — some producing invalid
SPARQL (loud failure), most producing **silently wrong results** (empty
arrays, dropped rows, or cross-product leaks with no error). Each was fixed
in the same effort, validated with a real exact-result E2E test against live
Fuseki, and the previously-quarantined (`test.skip`) test was un-skipped.
Final state: **0 skipped tests** in the coverage suite.

### 1 — SELECT: computed expression over a traversal emitted invalid SPARQL

`Person.select(p => p.bestFriend.name.ucase())` lowered to
`(UCASE(?a1_name) AS ?a1)` where `?a1` was already bound by the traversal
triple — Fuseki 400: `Variable used when already in-scope`. Fixed in
`src/sparql/irToAlgebra.ts` (projection loop): an expression projection whose
output alias collides with a traversal target variable is renamed to
`${alias}_expr` (mirroring the existing aggregate-collision guard), and
`query.resultMap` is updated to match.

### 2 — UPDATE: expression over a traversal was unscoped (data corruption)

`Person.update(p => ({hobby: p.bestFriend.name.ucase()})).for(p1)` where `p1`
has no `bestFriend` should be a no-op. Actual: `p1.hobby` was overwritten with
the UCASE of **every** person's name — the traversal edge was applied as a
LEFT JOIN *after* the leaf property triple, so an absent edge left the leaf
variable unbound and it matched every entity in the graph. A second variant
(`updateExprSharedTraversal`, two fields off one traversal) additionally
overwrote a `maxCount:1` property with five values. Fixed in
`updateToAlgebra` (`irToAlgebra.ts`): traversal-anchored leaf property triples
are now nested as their own OPTIONAL **inside** the traversal edge's OPTIONAL
group (edge first, then each leaf independently optional within that scope),
so an absent edge leaves every leaf unbound (no cross-entity match) and a
missing optional leaf doesn't drop its siblings.

### 3 — SELECT: inline `.where()` on a plural sub-select was silently dropped

`p.pluralTestProp.where(pp => pp.name.equals('Moa')).select(pp => [...])`
returned all four `pluralTestProp` entries instead of just Moa. Root cause:
`QueryShapeSet.where()` stores the predicate as `wherePath` on the query
object, but `.select()` → `FieldSet.forSubSelect` only captured
`parentSegments` — the filter was never transferred into the sub-select's
`FieldSetEntry` (the plain-path branch already walked the chain for this; the
FieldSet sub-select branch didn't). Fixed by passing the source query object
into `forSubSelect` (`QueryShapeSet.select`/`QueryShape.select` in
`src/queries/SelectQuery.ts`), walking it for `wherePath` and carrying it as
`parentWherePath`/`parentWherePathIndex` on the `FieldSet`
(`src/queries/FieldSet.ts`), then mapping it onto
`entry.scopedFilter`/`scopedFilterIndex` in `convertTraceResult`.

Fixing that exposed a **second** defect: once the filter reached the algebra,
the filtered traversal's children (nested sub-select traversals and projected
property triples on the filtered alias) were emitted as separate top-level
OPTIONALs. When the filter matched nothing, the alias was unbound and the
top-level OPTIONAL became an unconstrained cross-product over the whole
graph. Fixed in `irToAlgebra.ts` §5b: both now nest **inside** the filtered
OPTIONAL block.

### 4 — SELECT: nested aggregate mis-scoped to the parent row

`p.friends.select(f => ({name: f.name, numFriends: f.friends.size()}))`
should carry `numFriends` on each friend object. Actual: `numFriends` landed
on the **parent** person row, and friend objects had only `name`. The
generated SPARQL was already correct (`count(?a1_friends)` grouped per
friend) — the defect was in **result mapping**:
`buildNestingDescriptor` (`src/sparql/resultMapping.ts`) anchored every
non-property/alias expression at the root. Fixed by anchoring an
`aggregate_expr` to its property argument's `sourceAlias` (the entity it's
grouped by) instead of unconditionally the root; root-level aggregates
(`p.friends.size()`) are unaffected since their argument's sourceAlias *is*
the root.

### 5 — SELECT: `.one()` truncated a plural sub-row

`Person.select(p => p.friends.select(f => ({name, hobby}))).where(...).one()`
for a person with two friends (one with a null `hobby`) returned only one
friend. Not a null-property join issue as first suspected: `.one()` lowers to
`limit: 1` + `singleResult`, and SPARQL `LIMIT` bounds **rows**, not
entities — an entity with N friends spans N result rows, so `LIMIT 1`
truncated the nested array to whichever row came first. Fixed in
`irToAlgebra.ts`: when `singleResult && limit === 1` and the query yields
multiple rows per root entity (any traverse pattern, or a plural property
projection), the `LIMIT` is omitted and the result mapper (which already
groups by root id) picks the single entity. Flat single-valued `.one()`
queries (golden `selectOne`) keep their `LIMIT 1`.

### 6 — SELECT: `isNotDefined` could never match

`Person.select().where(p => p.hobby.isNotDefined())` returned `[]` instead of
the persons lacking a hobby. The hobby property triple was emitted as a
**required** (inner-join) pattern, so rows lacking it were filtered out
before `!BOUND(?hobby)` was evaluated — the negation could never be true.
Fixed in `collectRequiredBindingKeys` (`irToAlgebra.ts`): a `BOUND(...)`
function expression now contributes no required binding keys, so the
property lowers as OPTIONAL. `isDefined` (positive `BOUND`) is unaffected —
the filter itself already enforces boundness.

### 7 — SELECT: `Expr.ifThen` (and `firstDefined`/`concat`) evaluated the wrong row

`Expr.ifThen(p.name.equals('Semmy'), 'yes', 'no')` for the person actually
named Semmy returned `'no'`. Not branch inversion, as first suspected:
`Expr.ifThen`/`Expr.firstDefined`/`Expr.concat` construct an `ExpressionNode`
directly and dropped the `_refs` map carried by their `ExpressionInput`
arguments. A proxy-traced property inside the condition (e.g. `p.name`) keeps
an unresolved `__ref_N__` placeholder alias until `_refs` is walked at
lowering time; without it, the placeholder never resolved to the query
subject's variable and the condition's property pattern became an
unconstrained cross-product over every entity with that property — `IF`
evaluated against an arbitrary row. Fixed in `src/expressions/Expr.ts`: all
three functions now merge their arguments' `_refs` maps into the constructed
node (`mergedRefs`, matching the semantics `ExpressionNode._derive` already
uses for instance methods).

### 8 — SELECT: a filtered sub-select nested inside another filtered sub-select cross-producted

Building on bug 3's fix, a `.where()` on a sub-select **inside** another
filtered sub-select (e.g. outer filter `name='Moa'`, inner filter
`name='Jinx'`) still emitted the inner filtered block flat at the top level.
When the outer filter matched nothing, the inner block's subject alias was
unbound and the block cross-producted over every matching edge in the graph,
attaching spurious nested results to unrelated parents. Fixed in
`irToAlgebra.ts` §5b by assembling filtered blocks in two passes: build each
block's inner group first, then — walking children before parents in reverse
creation order (blocks are created parent-before-child) — nest each finished
block inside its parent's filtered block whenever its subject alias is
itself a filtered traversal target; only root-level blocks attach to the
top-level algebra.

### 9 — SELECT: `COALESCE`/`IF` arguments in a where-filter were marked required

`p.hobby.defaultTo('none').equals('none')` in a `.where()` returned `[]`
instead of the persons lacking a hobby — same failure family as bug 6, but on
`COALESCE` instead of `BOUND`, and reachable purely through the public DSL
(`defaultTo`). Likewise `Expr.ifThen(...)` in a `.where()` inner-joined
properties referenced by its branches, dropping entities the *taken* branch
would otherwise have matched. Fixed in `collectRequiredBindingKeys`:
`COALESCE` now contributes no required binding keys (unbound-tolerant by
design); `IF` keeps only its **condition's** requirements (an unbound
condition variable errors the row out under either join strategy, so no
harm in keeping it required) while its then/else branches stay optional,
since the untaken branch may reference a property the entity doesn't have.

## Known residual limitations (not bugs, documented and left as-is)

- **Bare proxy property as an `Expr.*` argument throws.** Passing
  `p.hobby` (rather than `p.hobby.str()`) directly as an
  `Expr.ifThen`/`Expr.firstDefined` argument throws `Invalid expression
  input` — the raw proxy object isn't an `ExpressionNode`. Method-wrapped
  forms work. This fails loudly, not silently, so it was left as a follow-up
  ergonomics gap rather than fixed here.
- **`sum`/`avg`/`min`/`max` aggregates are not reachable from the DSL.** The
  IR (`IRAggregateExpression`) and SPARQL serializer already support all five
  generically; only `.size()`/count has a DSL surface. This is feature work,
  not a bug, and is tracked as its own future effort (sketch: add
  `.sum()/.avg()/.min()/.max()` to `QueryShapeSet`/numeric `QueryPrimitive`
  mirroring `SetSize`; widen `FieldSetEntry.aggregation`; generalize
  `DesugaredCountStep` to carry an aggregate name). When picked up, add
  exact-result E2E tests over `Metric.scores` (already seeded for this).
- **`customResultEqualsBoolean`** (`{isBestFriend: p.bestFriend.equals(p3)}`)
  only asserts the result is an array — the boolean field isn't actually
  projected. Pre-existing, documented, out of scope here.
- **Language-tagged literals** (`"Hi"@en`) were out of scope for this effort.

## Files changed

- `src/tests/sparql-fuseki-coverage.test.ts` — new, 952 lines, 90 tests, 0
  skipped. Own extended seed (`Person/Employee/Dog/Pet` + `Metric` + `PathNode`
  + extra `Person` edges), `FusekiStore` harness with skip-if-no-Fuseki guard,
  `reloadBase()` for mutation-test isolation.
- `src/test-helpers/query-fixtures.ts` — additive: `Metric` shape, `PathNode`
  shape, and new query factories (`whereExprDefaultTo`, `whereExprIfThen`,
  `nestedFilteredSubSelects`, etc.). No existing fixture modified.
- `src/sparql/irToAlgebra.ts` — the bulk of the fixes: projection-alias
  collision rename (bug 1), `updateToAlgebra` traversal-scoped OPTIONAL
  nesting (bug 2), filtered-block two-pass assembly with parent/child nesting
  (bugs 3, 8), `.one()` LIMIT omission for multi-row entities (bug 5),
  `collectRequiredBindingKeys` unbound-tolerant-function handling (bugs 6, 9).
- `src/sparql/resultMapping.ts` — `buildNestingDescriptor` aggregate-alias
  anchoring fix (bug 4).
- `src/expressions/Expr.ts` — `mergedRefs` helper; `ifThen`/`firstDefined`/
  `concat` now carry argument refs (bug 7).
- `src/queries/FieldSet.ts` / `src/queries/SelectQuery.ts` — `forSubSelect`
  carries the parent chain's `wherePath` into the sub-select FieldSet (bug 3).

## Test strategy used

- **Fast gate** (no Docker, ~1–2 min):
  `npx jest --config jest.config.js --runInBand --testPathPattern='ir-|sparql-.*-golden|serialization|field-set|query-builder|lower|mutation-serialization'`
  — catches fixture/golden regressions from `query-fixtures.ts` edits.
- **Fuseki gate**: brings up a live SPARQL endpoint and runs the new suite
  with exact-result assertions through the store contract. Docker's Fuseki
  image registry host was egress-blocked in this environment; Fuseki was run
  instead from the Apache Jena 5.5.0 standalone distribution
  (`archive.apache.org`, an allowed host) via a local-only helper script —
  not committed to the repo, environment-specific scaffolding only.
- **Full suite** (`npm test`) run before every commit in this effort.

Final validated state: coverage suite **90 passed, 0 skipped**; full repo
suite **1444 passed, 0 failed, 117 skipped** (pre-existing, by-design skips —
compile-only type-inference `describe.skip` blocks and similar, unrelated to
this effort).

## Notes for future work

- Backlog `docs/backlog/006-dsl-aggregates-sum-avg-min-max.md` still tracks
  the `sum`/`avg`/`min`/`max` DSL surface work described above — not
  resolved by this effort, kept open.
- The store-contract test pattern established here
  (`sparql-fuseki-coverage.test.ts`: extended seed, `FusekiStore` harness,
  `reloadBase()` for mutation isolation, assertions via
  `store.selectQuery/createQuery/updateQuery/deleteQuery`) is the template to
  follow for any future E2E coverage work — it exercises the full
  query → lower → SPARQL → execute → map pipeline as a black box, which is
  exactly what caught bugs the golden/IR tests missed (golden tests only
  assert SPARQL-string substring presence, not validity or result
  correctness).
