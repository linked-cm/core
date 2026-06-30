---
summary: Three correctness bugs in nested sub-select lowering surfaced by E2E coverage tests — dropped filter, mis-scoped aggregate, and dropped null-property row under .one().
---

# Nested sub-select lowering bugs

Surfaced by `src/tests/sparql-fuseki-coverage.test.ts` (plan 001, Phase 2)
running the deep-nesting fixtures through the live Fuseki store. 11 of the 14
deep-nesting fixtures are correct; these 3 are quarantined (`test.skip`).

## Bug 3 — inline `.where()` on a plural sub-select is dropped

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

## Bug 4 — nested aggregate is mis-scoped to the parent row

`subSelectWithCount`:
```ts
Person.select(p => p.friends.select(f => ({name: f.name, numFriends: f.friends.size()})))
```
Expected: each friend object carries its own `numFriends`. Actual: `numFriends`
is attached to the **parent** person row (e.g. `p1.numFriends = 2`) and the
friend objects only contain `name`. The `count` aggregate over the inner
traversal is lowered against the outer subject's GROUP BY instead of the
sub-select's.

## Bug 5 — `.one()` drops a sub-select row with a null projected property

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

Quarantined (`test.skip`) in the coverage suite. Decision pending (plan 001):
these plus backlog 003 are 5 core lowering bugs; fixing them is a separate
correctness effort beyond the test-coverage scope.
