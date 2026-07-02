---
summary: Two operator lowering bugs surfaced by E2E coverage — isNotDefined never matches, and Expr.ifThen returns the wrong branch. Both fixed.
---

# Operator lowering bugs

Surfaced by `src/tests/sparql-fuseki-coverage.test.ts` (plan 001, Phase 2/§2).
All other operators (string, numeric, date, defaultTo/coalesce, str, datatype,
md5, sha256, isDefined) lower correctly with exact results.

## Bug 6 — `isNotDefined` can never match — ✅ FIXED

> Fixed in `src/sparql/irToAlgebra.ts` (`collectRequiredBindingKeys`): a
> `function_expr` named `BOUND` now contributes **no** required binding keys, so
> a property whose only filter reference is `BOUND`/`!BOUND` stays an OPTIONAL
> left-join and `FILTER(!BOUND(?x))` can match. `isDefined` (positive `BOUND`)
> keeps identical results — the filter itself enforces boundness.
> Test un-quarantined: asserts `['p3','p4','p5']`.

`Person.select().where(p => p.hobby.isNotDefined())` returns `[]`. Expected the
persons without a hobby (`p3, p4, p5`). The hobby property triple is emitted as a
**required** (inner-join) pattern, so rows lacking it are filtered out before
`!BOUND(?hobby)` is evaluated → the negation can never be true. The property must
be lowered as OPTIONAL when the only reference to it is a `!BOUND`/isNotDefined
predicate. (`isDefined` works because inner-join already implies bound.)

## Bug 7 — `Expr.ifThen` returns the else-branch when the condition is true — ✅ FIXED

> Root cause (revised from the original diagnosis): the branches were **not**
> swapped. `Expr.ifThen` / `Expr.firstDefined` / `Expr.concat` construct a
> `new ExpressionNode(...)` directly and dropped the `_refs` maps of their
> arguments, so a proxy-traced property in the condition kept its unresolved
> `__ref_N__` placeholder alias. The lowered pattern
> `OPTIONAL { ?__ref_1__ <name> ?__ref_1___name }` was an unconstrained
> cross-product over every entity with the property, and the IF evaluated
> against an arbitrary row's value. Fixed in `src/expressions/Expr.ts`: those
> three functions now pass `mergedRefs(args)` to the `ExpressionNode`
> constructor (same semantics as `_derive`), so the condition resolves to the
> query subject's own variable. Test un-quarantined: asserts per-row branches
> for all persons plus the boolean-condition variant.

`Expr.ifThen(p.name.equals('Semmy'), 'yes', 'no')` for p1 (name = "Semmy")
returns `'no'`; `Expr.ifThen(p.isRealPerson.equals(true), 'real', 'fake')` for a
real person returns `'fake'`.
(Passing a raw property as the condition instead of a comparison throws
`Invalid expression input` — separate, lower priority.)

## Residual (not yet covered by a failing test)

`COALESCE`/`IF` arguments in a **where** filter are still marked required by
`collectRequiredBindingKeys` — e.g. `p.hobby.defaultTo('none').equals('none')`
would inner-join `hobby` and miss rows lacking it. Same bug family as Bug 6;
fix would be to treat null-tolerant functions' args as non-required. Low
priority until a use case hits it.

## Status

Both bugs fixed and un-quarantined; coverage suite asserts exact results
against live Fuseki.
