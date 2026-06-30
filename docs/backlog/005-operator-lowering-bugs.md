---
summary: Two operator lowering bugs surfaced by E2E coverage — isNotDefined never matches, and Expr.ifThen returns the wrong branch.
---

# Operator lowering bugs

Surfaced by `src/tests/sparql-fuseki-coverage.test.ts` (plan 001, Phase 2/§2).
All other operators (string, numeric, date, defaultTo/coalesce, str, datatype,
md5, sha256, isDefined) lower correctly with exact results.

## Bug 6 — `isNotDefined` can never match

`Person.select().where(p => p.hobby.isNotDefined())` returns `[]`. Expected the
persons without a hobby (`p3, p4, p5`). The hobby property triple is emitted as a
**required** (inner-join) pattern, so rows lacking it are filtered out before
`!BOUND(?hobby)` is evaluated → the negation can never be true. The property must
be lowered as OPTIONAL when the only reference to it is a `!BOUND`/isNotDefined
predicate. (`isDefined` works because inner-join already implies bound.)

## Bug 7 — `Expr.ifThen` returns the else-branch when the condition is true

`Expr.ifThen(p.name.equals('Semmy'), 'yes', 'no')` for p1 (name = "Semmy")
returns `'no'`; `Expr.ifThen(p.isRealPerson.equals(true), 'real', 'fake')` for a
real person returns `'fake'`. The IF condition is inverted or the branches are
swapped in the `function_expr('if', …)` lowering / SPARQL `IF(...)` rendering.
(Passing a raw property as the condition instead of a comparison throws
`Invalid expression input` — separate, lower priority.)

## Status

Quarantined (`test.skip`). Decision pending (plan 001) alongside backlog 003/004.
