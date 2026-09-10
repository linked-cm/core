---
summary: All seven live-Fuseki test suites read and write one hardcoded dataset (`nashville-test`), so any Jest run without `--runInBand` corrupts its own fixtures. Give each suite its own dataset, or serialize at the config level rather than by flag.
packages: [core]
---

# 037 — Fuseki suites share one dataset

`src/test-helpers/fuseki-test-store.ts` hardcodes `DATASET_NAME = 'nashville-test'`. Seven suites
(`sparql-fuseki`, `sparql-fuseki-coverage`, `sparql-fuseki-shape-sync`, `property-path-fuseki`,
`nested-select-pagination`, `property-path-named-resolution`, `shacl-cascade`) seed, mutate, clear
and re-seed it. Jest's default parallel workers therefore have them destroying each other's
fixtures mid-run.

`npm test` has always passed only because it happens to pass `--runInBand`. `npm run test:fuseki`
did **not**, and failed ~40 tests for anyone who ran the command the repo documents for these
suites; that was fixed in the `Shape.exists` PR (report 028) by adding the same flag. The
underlying fragility remains: `npx jest src/tests/sparql-fuseki` — the obvious dev shortcut —
still corrupts itself, and the failures look like product bugs rather than a harness problem.

Options:

1. **Per-suite dataset name** — derive it from the test filename (`nashville-test-${basename}`) in
   `fuseki-test-store.ts` and create it in each suite's `beforeAll`. Restores parallelism, and the
   dataset name in a failure message then points at the suite.
2. **`maxWorkers: 1` for the fuseki suites in `jest.config.cjs`** — correct by construction and
   independent of how Jest is invoked, but serializes them permanently.
3. Named graphs per suite within the one dataset — cheapest to set up, but every query would need
   graph scoping, which the query pipeline does not yet express (see backlog 005).

Option 1 is preferred; option 2 is a safe interim that removes the "obvious command is wrong" trap.
