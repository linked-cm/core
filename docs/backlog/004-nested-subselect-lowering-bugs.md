---
summary: Three correctness bugs in nested sub-select lowering surfaced by E2E coverage tests — dropped filter, mis-scoped aggregate, and dropped null-property row under .one(). All fixed.
---

# Nested sub-select lowering bugs

Surfaced by `src/tests/sparql-fuseki-coverage.test.ts` (plan 001, Phase 2)
running the deep-nesting fixtures through the live Fuseki store. 11 of the 14
deep-nesting fixtures were correct; these 3 were quarantined (`test.skip`) and
are now fixed and un-quarantined.

## Bug 3 — inline `.where()` on a plural sub-select is dropped — ✅ FIXED

> Root cause: `QueryShapeSet.where()` stores the predicate as `wherePath` on the
> query object, but `.select()` → `FieldSet.forSubSelect` only captured
> `parentSegments` — the wherePath was never transferred to the FieldSet entry
> (the plain-path branch of `convertTraceResult` walks the chain for it; the
> FieldSet sub-select branch didn't). Fixed by passing the source query object
> into `forSubSelect` (both `QueryShapeSet.select` and `QueryShape.select` in
> `src/queries/SelectQuery.ts`), walking it for `wherePath` and carrying it as
> `parentWherePath`/`parentWherePathIndex` on the FieldSet
> (`src/queries/FieldSet.ts`), then mapping it onto
> `entry.scopedFilter`/`scopedFilterIndex` in `convertTraceResult`.
>
> A second latent defect surfaced once the filter reached the algebra: the
> filtered traversal's **children** (nested sub-select traversals and projected
> property triples on the filtered alias) were emitted as separate top-level
> OPTIONALs. When the filter matched nothing the alias was unbound, and the
> top-level OPTIONAL became an unconstrained cross-product over the whole graph.
> Fixed in `src/sparql/irToAlgebra.ts` (section 5b): both now nest INSIDE the
> filtered OPTIONAL block.
>
> DSL-JSON already round-trips the filter (`where` + `whereIndex` on the
> sub-select field) — verified IR-identical after `fromJSON(toJSON(q))`.

`pluralFilteredNestedSubSelect`:
```ts
Person.select(p =>
  p.pluralTestProp
    .where(pp => pp.name.equals('Moa'))
    .select(pp => [pp.name, pp.friends.select(f => [f.name, f.hobby])]))
```
p1's `pluralTestProp` is `[p1, p2, p3, p4]`; the filter should reduce it to just
`p2` (Moa). Actual: all four are returned — the `.where()` predicate is lost when
the plural sub-select also carries a `.select()` projection. (A plain
`p.friends.where(name='Moa')` without the nested `.select()` filters correctly,
so the regression is specific to filter + nested projection.)

## Bug 4 — nested aggregate is mis-scoped to the parent row — ✅ FIXED

> Root cause: the generated SPARQL was already correct (`count(?a1_friends)`
> with `GROUP BY ?a0 ?a1 …` counts per friend) — the defect was in **result
> mapping**. `buildNestingDescriptor` (`src/sparql/resultMapping.ts`) anchored
> every non-property/alias expression at the root, so `numFriends` landed on the
> parent row. An `aggregate_expr` is now anchored to its property argument's
> `sourceAlias` (the entity it is grouped by), placing the count inside each
> friend object. Root-level aggregates (`p.friends.size()`) are unaffected —
> their argument's sourceAlias IS the root.

`subSelectWithCount`:
```ts
Person.select(p => p.friends.select(f => ({name: f.name, numFriends: f.friends.size()})))
```
Expected: each friend object carries its own `numFriends`. Actual: `numFriends`
is attached to the **parent** person row (e.g. `p1.numFriends = 2`) and the
friend objects only contain `name`. The `count` aggregate over the inner
traversal is lowered against the outer subject's GROUP BY instead of the
sub-select's.

## Bug 5 — `.one()` drops a sub-select row with a null projected property — ✅ FIXED

> Root cause (revised): not a join problem — the generated pattern was correct.
> `.one()` lowers to `limit: 1` + `singleResult`, and SPARQL `LIMIT 1` bounds
> **rows**, not entities: an entity with N friends spans N rows, so the LIMIT
> truncated the friends array to whichever row came first (Jinx just happened to
> be the truncated one). Fixed in `src/sparql/irToAlgebra.ts`: when
> `singleResult && limit === 1` and the query yields multiple rows per root
> entity (any traverse pattern, or a plural property projection), the LIMIT is
> omitted and the result mapper picks the single entity. Flat single-valued
> `.one()` queries (golden `selectOne`) keep their `LIMIT 1`.

`subSelectWithOne`:
```ts
Person.select(p => p.friends.select(f => ({name: f.name, hobby: f.hobby})))
  .where(p => p.equals(entity('p1'))).one()
```
p1 has friends p2 (Moa, hobby Jogging) and p3 (Jinx, no hobby). Expected: both.
Actual: only Moa — Jinx is dropped because its `hobby` is null. The
single-subject `.one()` path appears to inner-join the optional property instead
of left-joining it (the non-`.one()` variant `subSelectPluralCustom` keeps both).

## Status

All three bugs fixed and un-quarantined; the coverage suite asserts exact
results against live Fuseki (14/14 deep-nesting fixtures correct, 0 skips).

## Residual (noted, not covered by a failing test)

Nested filtered traversals (a `.where()` on a sub-select **inside** another
filtered sub-select) still emit each filtered block flat at the top level, so
the inner block's subject alias can be unbound — same cross-product family as
the Bug 3 nesting defect, one level deeper. No fixture exercises this yet.
