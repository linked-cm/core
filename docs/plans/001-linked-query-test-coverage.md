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

## Open items / decisions

(tracked in chat first — see open questions)

## Accepted decisions

_(none yet)_
