---
summary: Behavior-preserving simplification & leanness pass over @_linked/core — remove dead code, an unused dependency, build-config bloat, a no-op IR pass, and add two hot-path memoizations. Safety net is the full 1444-test suite staying green.
status: Ideation
source_report: docs/reports/021-repo-analysis-cleanup-security-gaps.md (section 1)
packages: [core]
---

# 001 — Simplification & Leanness

Derived from the §1 findings of report 021. **Constraint: same functionality, all tests passing.** The full suite (`npm test` → 1444 passed, 117 skipped) is the acceptance gate after every phase; behavior-changing fixes and public-surface removals are explicitly out of scope for this thread.

## Source findings (report 021 §1, verbatim scope)

- S1 Published package ships `src/test-helpers/` (tsconfig `exclude` only lists `./src/tests/**`); `query-capture-store.ts` imports `@jest/globals`, `fuseki-test-store.ts` imports `child_process`.
- S3 Unused runtime dependency `next-tick` (zero imports; `ulid` is used — keep).
- S4 PERF: `resolvePropertyPredicateTerm` (`sparql/irToAlgebra.ts:106`) scans the whole ontology per predicate, 10 call sites, no memo.
- S5 PERF: `collectContainment()` (`irToAlgebra.ts:2041`) recomputed per cascade item inside loops.
- S6 `IRCanonicalize` is a self-documented no-op pass (`canonicalizeWhere` returns input in both arms) that still copies every query object.
- Dead code: `utils/Types.ts` (19 lines, zero importers, not exported), unused imports (`irToAlgebra.ts:23,40`; `SHACL.ts:9`; `Shape.ts:10`; `Expr.ts:89` dead destructure), commented-out code (`MutationQuery.ts:181`).
- Build config: `tsconfig.json` `emitDecoratorMetadata` (no reflect-metadata consumer), `jsx:"react"` (no .tsx), `downlevelIteration` (no-op at es6), phantom `include`/`paths` entries; `package.json` `"types":"./index.d.ts"` (file doesn't exist); `jest.config.js` `testPathIgnorePatterns:['/old/']` (no such dir).

## Architecture context

`npx semantu-agents docs architecture` → no `docs/architecture` docs exist. No architecture constraints to comply with; the DSL→IR→SPARQL pipeline contract in `documentation/` (dsl-json, intermediate-representation, sparql-algebra) is the de-facto contract and MUST be preserved (golden tests enforce it).

## Test surfaces

- Single package (repo root). Quick gate: `npx jest --config jest.config.js --runInBand` runs full suite in ~16s — fast enough to be BOTH the quick gate and the full gate. No separate slow suite except Fuseki (`test:fuseki`, requires Docker; skipped here, no Docker).
- Golden tests that lock behavior for the perf/no-op-collapse phases: `sparql-select-golden`, `sparql-mutation-golden`, `ir-select-golden`, `ir-canonicalize`, `lower`, plus the full `property-path-*` and `shacl-*` suites.

## Open-item map & decisions (automatic-mode ideation)

Priority framework: (1) long-term maintainability, (2) scalability, (3) performance.

### Decision 1 of 5 — Behavior-changing bug fixes (S2 type-clobber, `Prefix._toFull`, `cached.ts`)
**Decision: DEFER to backlog.** They change runtime behavior; the thread's brief is "keep same functionality." Mixing correctness fixes into a cleanup PR harms reviewability and traceability (maintainability). → backlog doc at review/wrapup.

### Decision 2 of 5 — Public-surface removals (dead members inside `ShapeClass`, `QueryFactory.checkNewCount`, `CoreSet/CoreMap` unused methods, `WhereCondition`, `initModularApp`, `serializePathToSHACL`)
**Decision: OUT OF SCOPE for this thread.** All are reachable through `index.ts` (`initModularApp` dumps every module namespace onto a global, and several are re-exported as types). Removing them changes the published surface — not strictly behavior-preserving for downstream `@_linked/react`/consumers. `serializePathToSHACL` additionally has a dedicated test; deleting it would lose coverage. Keep the thread to internal-only, zero-exposure changes. Flag as a review gap for a follow-up "public API prune" thread.

### Decision 3 of 5 — Scope of build-config changes
**Decision: INCLUDE tsconfig + jest.config + package.json `types` fixes; LEAVE package.json `scripts` alone.** `npm run setup` (semantu-agents) just rewrote `scripts`; touching them risks churn/conflict. The config changes are validated by `npm run compile` + full test. `emitDecoratorMetadata` removal is safe because no `reflect-metadata`/`design:type` consumer exists (verified) — decorators work via `experimentalDecorators`, which stays.

### Decision 4 of 5 — `IRCanonicalize` collapse depth
**Decision: Collapse to type aliases + drop the passthrough calls at the 3 call sites (`IRPipeline.ts:23`, `lower.ts:60`, `lowerMutationJSON.ts:149`).** Removes a conceptual layer and a per-query object copy. Behavior-preserving (function is provably identity); `ir-canonicalize`/golden tests guard it. Keep the exported type names (`CanonicalWhereExpression`) as aliases so no import breaks.

### Decision 5 of 5 — Large duplication refactors (builder base class, decoder unification, lower.ts/lowerMutationJSON merge)
**Decision: DEFER to backlog.** Highest line-count but highest risk and largest surface; belongs in its own reviewed thread. Small, local, obviously-safe extractions are acceptable inside this thread only if they fall out naturally; no speculative refactoring.

## Selected route

A 4-phase behavior-preserving pass, each phase gated by the full test suite:
1. Dependency + build-config leanness (no src logic).
2. Internal dead code + unused imports.
3. `IRCanonicalize` no-op collapse.
4. Hot-path memoization (`resolvePropertyPredicateTerm`, `collectContainment`).

Deferred (→ backlog at review): behavior-changing bug fixes; public-surface prune; large duplication refactors.
