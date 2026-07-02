---
summary: The six Fuseki integration suites early-return when Docker is absent, so CI without Docker reports success while executing none of the live-SPARQL assertions — SparqlDataset is effectively untested. Surfaced during the cleanup review (report 022, Gap 4) and independently in report 021 Tier 6.
packages: [core]
---

# 009 — CI/test integrity: Fuseki false-green suites

> Source: deferred from report 022 review (Gap 4); also report 021 §3 Tier 6.

## Problem
All six Fuseki suites (`sparql-fuseki*`, `property-path-fuseki`,
`sparql-fuseki-shape-sync`, `sparql-fuseki-coverage`) guard every test body with
`if (!fusekiAvailable) return;`. When Docker is absent (the default CI and this
environment), each test **passes without asserting anything** — the suite reports
green while executing zero live-SPARQL, shape-sync, property-path, or
nested-pagination checks. `SparqlDataset` is only reachable through these, so it
is effectively untested in normal CI.

This is not a correctness bug in the library; it is a **test-integrity gap**: a
regression in the live execution path would not be caught by a Docker-less run.

## What we can do
1. **Fail-or-skip, don't silent-pass:** replace the early-`return` guard with
   Jest's `describe.skip`/`test.skip` (marks tests skipped, visible in output)
   or a hard failure when an env flag (e.g. `REQUIRE_FUSEKI=1`) is set — so CI
   can be configured to require them.
2. **Run Fuseki in CI:** the `test:fuseki` script + `docker-compose.test.yml`
   already exist; wire a CI job that starts Fuseki and runs them for real.
3. **Report skipped count prominently** so a green run that skipped 100+ live
   assertions is not mistaken for full coverage.

## Open questions
- Which CI provider / does it allow Docker services?
- Should the unit run treat missing Fuseki as skipped (visible) or as failure
  behind a required-flag?

## Recommendation
At minimum, convert the silent `return` guards to visible `skip` so the coverage
gap is honest; ideally add a Dockerized CI job so `SparqlDataset` is exercised.
