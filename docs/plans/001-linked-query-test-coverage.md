---
summary: Expand the hand-written linked-query E2E test suite (queries + seed data) to cover the features core supports but currently leaves untested.
status: Ideation
source: docs/linked-query-test-coverage.md
---

# Linked-query test coverage expansion

## Context

`src/tests/sparql-fuseki.test.ts` runs 77 of 132 fixtures from
`query-fixtures.ts` against the Fuseki `Person/Employee/Dog/Pet` seed graph.
The full gap analysis lives in `docs/linked-query-test-coverage.md`. This plan
turns that analysis into an implemented, committed test expansion.

## Scope (candidate)

1. Wire the 55 already-written-but-unexecuted fixtures into the Fuseki suite.
2. Add fixtures + tests for the ~50 untested expression/filter operators.
3. Extend the seed graph for datatype coverage (decimal/double/float/long/date/langString).
4. Property paths through the DSL (not just raw SPARQL).
5. Builder features untested E2E (multi-key orderBy, top-level offset, JSON round-trip, context).

## Test surfaces (discovered)

- Quick/full: `npm test` (`jest --runInBand`, matches `src/tests/*.test.ts`).
- Fuseki E2E: `npm run test:fuseki` (spins up docker compose Fuseki, runs
  `sparql-fuseki` pattern, tears down). Tests self-skip when Fuseki is absent.
- Architecture docs: none present (`docs/architecture/` empty; private
  `semantu-agents` skills were not fetched — no git access).

## Ideation findings (explored)

- **Aggregates `sum/avg/min/max`: NOT reachable from the DSL.** Only `count`
  (via `.size()`). IR (`aggregate_expr`) + SPARQL serialization already support
  all five generically; the gap is the DSL surface + FieldSet/IRDesugar lowering
  (`aggregation?: 'count'` is hardcoded). Exposing them is ~5 small edits.
- **Property paths through the DSL: pipeline is sound E2E** (decorator
  `{seq|inv|alt|oneOrMore|...}` → IRTraversePattern.pathExpr → `pathExprToSparql`),
  but **no test runs `Shape.select` on a complex-path decorator and asserts
  mapped results** — existing path tests use raw SPARQL or golden strings. Safe
  to add; should pass.
- **All untested operators lower to valid SPARQL** (CONCAT/CONTAINS/STRSTARTS/
  SUBSTR/REPLACE/REGEX, ABS/ROUND/CEIL/FLOOR, YEAR/MONTH/DAY, BOUND/COALESCE/IF,
  gte/lte, STR/DATATYPE, MD5/SHA256/SHA512). None broken. `power` unrolls to
  repeated multiplication by design. Exact-result tests are safe.
- **Fixture soundness:** Groups MINUS, bulk/conditional mutations, expression
  WHERE, negation/quantifier, computed projections, expression updates are all
  **SOUND** (golden-tested). The 15 **deep-nesting/sub-select fixtures are
  RISKY** — no golden SPARQL tests, only type tests; exact-result assertions may
  surface nested-mapping bugs.

## Accepted decisions

- All five gap categories in scope. §1 (wire unexecuted fixtures) is the first
  phase(s) and must be validated (`npm run test:fuseki`) before later phases.
- Extend the existing `Person`/Fuseki graph for new edges; add a **separate new
  shape** (not on `Person`) for datatype coverage. Must keep all existing
  golden/E2E assertions valid when touching shared fixtures.
- Assert **exact** results, matching the current suite's style.
- Mutations tested against the throwaway test graph (no separate dataset needed).
- **Language-tagged strings are out of scope** — single language assumed; lang
  behavior is not in core, so no lang tests.
