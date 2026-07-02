---
summary: Behavior-preserving simplification & leanness pass over @_linked/core — remove dead code, an unused dependency, build-config bloat, a no-op IR pass, and add two hot-path memoizations. Safety net is the full 1444-test suite staying green.
status: Review
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

## Plan

### Architecture compliance
No `docs/architecture` docs exist (`npx semantu-agents docs architecture` → empty). The binding contract is the DSL→IR→SPARQL behavior locked by golden tests (`ir-*-golden`, `sparql-*-golden`, `ir-canonicalize`) and the wire round-trip gate (`dsl-json-roundtrip`). Every phase must leave these byte-identical.

### Phase 1 — Dependency + build-config leanness (no `src/` logic)
Files:
- `package.json`: remove `"next-tick": "^1.1.0"` from `dependencies` (verified zero usage across `.ts/.js/.mjs`). Change `"types": "./index.d.ts"` → `"types": "./lib/esm/index.d.ts"` (the real declaration entry; matches `exports.types` and `typesVersions`). Leave `scripts` untouched (semantu-agents owns them).
- `tsconfig.json`: add `"./src/test-helpers/**"` to `exclude` (stops shipping test-only modules — inherited by `tsconfig-cjs/esm.json`, both of which `extends` it and override neither include nor exclude; `tsconfig-tests.json` sets `exclude:[]` and ts-jest transforms on demand, so tests are unaffected). Remove provably-inert options: `emitDecoratorMetadata` (no `reflect-metadata`/`design:type` consumer — verified; decorators keep working via `experimentalDecorators`), `downlevelIteration` (no-op at `target:es6`), `jsx:"react"` (no `.tsx` files). In `include`, drop `"./src/**/*.tsx"` and the phantom `"../node_modules/ts-jest/globals.d.ts"`. **Keep** `types:["node","jest"]` (ts-jest transform uses this tsconfig; removing jest breaks test typecheck) and **keep** `paths` (module-resolution risk, negligible payoff).
- `jest.config.js`: remove `testPathIgnorePatterns: ['/old/']` (no `old/` dir).

Pitfall: if excluding test-helpers ever broke ts-jest, add `./src/test-helpers/**` to `tsconfig-tests.json` `include`; the full-suite gate catches it.

Validation: `npm run compile` exits 0; `npm test` → 1444 passed / 117 skipped (unchanged). Manual: `npx tsc -p tsconfig-esm.json` emits no `lib/esm/test-helpers/**`.

### Phase 2 — Internal dead code + unused imports (zero public exposure)
Files:
- Delete `src/utils/Types.ts` (19 lines; zero importers, not in `index.ts` — verified).
- Remove unused imports: `src/sparql/irToAlgebra.ts:23,40` (`SparqlDeleteWherePlan`, `deleteWherePlanToSparql`), `src/shapes/SHACL.ts:9` (`URI`), `src/shapes/Shape.ts:10` (`QueryShape` type).
- `src/expressions/Expr.ts:89`: remove the dead `const [first, ...rest] = parts;` destructure (both bindings unused — verified by tsc noUnusedLocals).
- `src/queries/MutationQuery.ts:181`: delete the commented-out `// let value = obj[propShape.label];` line.

Scope guard: only symbols with zero references anywhere in `src/` (incl. tests) and no `index.ts` exposure. NOT touched here: `ShapeClass` stubs, `QueryFactory.checkNewCount`, `CoreSet/CoreMap` methods, `serializePathToSHACL`, `WhereCondition`, `initModularApp` — all reachable via `index.ts` (Decision 2, deferred).

Validation: `npm run compile` exits 0 (proves no dangling references); `npm test` unchanged.

### Phase 3 — Remove the `canonicalizeWhere` no-op indirection
`canonicalizeWhere` is a provable type-preserving identity: its param `DesugaredWhere` is definitionally `DesugaredExpressionWhere | DesugaredExistsWhere`, exactly its return type `CanonicalWhereExpression` (verified `IRDesugar.ts:122`, `IRCanonicalize.ts:9`).
Files (`src/queries/`):
- `IRCanonicalize.ts`: delete `canonicalizeWhere`. **Keep** the three exported types (`CanonicalWhereExpression`, `CanonicalMinusEntry`, `CanonicalDesugaredSelectQuery` — used by `IRLower` signatures). **Keep** `canonicalizeDesugaredSelectQuery` but replace its internal `canonicalizeWhere(x)` calls with `x` directly — note its `minusEntries` `.map` *reshapes* entries to `{shapeId, where, propertyPaths}`, which is NOT a no-op, so that mapping stays.
- `lower.ts:60`: `lowerWhereToIR(canonicalizeWhere(toWhere(where)))` → `lowerWhereToIR(toWhere(where))`; drop the now-unused import (`:33`).
- `lowerMutationJSON.ts:149`: `const canonical = canonicalizeWhere(toWhere(wherePath))` → `const canonical = toWhere(wherePath)`; drop the import (`:32`).
- `IRPipeline.ts`: unchanged (still calls `canonicalizeDesugaredSelectQuery`).

Pitfall: if tsc flags any identity-inline type mismatch, keep `canonicalizeWhere` as a one-line typed identity instead of inlining — behavior identical. Validation: `npm run compile` + `npm test`, with special attention to `ir-canonicalize`, `lower`, `ir-select-golden`, `sparql-*-golden` staying green.

### Phase 4 — Hot-path memoization (behavior-preserving)
`src/sparql/irToAlgebra.ts`:
- `resolvePropertyPredicateTerm(propertyId)` (`:106`): add a module-level `Map<string, SparqlTerm>` cache guarded by registry size. Cache only **successful** resolutions (skip the not-found `iriTerm(propertyId)` fallback so a later shape registration can still resolve correctly):
  ```ts
  const predicateTermCache = new Map<string, SparqlTerm>();
  let predicateCacheSize = -1;
  function resolvePropertyPredicateTerm(propertyId: string): SparqlTerm {
    const shapeClasses = getAllShapeClasses();
    if (shapeClasses.size !== predicateCacheSize) { predicateTermCache.clear(); predicateCacheSize = shapeClasses.size; }
    const hit = predicateTermCache.get(propertyId);
    if (hit) return hit;
    for (const shapeClass of shapeClasses.values()) { /* …unchanged… */
      // on match: const term = …; predicateTermCache.set(propertyId, term); return term;
    }
    return iriTerm(propertyId); // NOT cached
  }
  ```
- `collectContainment()` (`:2041`): memoize the single result, guarded by the same registry-size check (recompute when `getAllShapeClasses().size` changes). No signature/threading changes.

Rationale: `getAllShapeClasses()` returns the live `nodeShapeToShapeClass` map (`ShapeClass.ts:54`), so `.size` is O(1); shapes are stable within a process except for registration growth, which the size guard captures. Turns per-predicate / per-cascade full-ontology scans into O(1) hits.

Validation: `npm run compile` + full `npm test`. Golden SPARQL/IR output must be byte-identical (memoization changes nothing observable). This is the phase most reliant on golden coverage — confirm `sparql-select-golden`, `sparql-mutation-golden`, `property-path-*`, `shacl-cascade` all pass.

### Test strategy (all phases)
Quick gate == full gate: `npm test` (~16s, 1444 tests). Run `npm run compile` first each phase to catch type errors fast. Fuseki suites (`test:fuseki`) deferred to review — no Docker here, so they stay skipped (documented). One commit per phase (code + plan status update together).

### Files expected to change
`package.json`, `tsconfig.json`, `jest.config.js` (P1); `src/utils/Types.ts` (delete), `src/sparql/irToAlgebra.ts`, `src/shapes/SHACL.ts`, `src/shapes/Shape.ts`, `src/expressions/Expr.ts`, `src/queries/MutationQuery.ts` (P2); `src/queries/IRCanonicalize.ts`, `lower.ts`, `lowerMutationJSON.ts` (P3); `src/sparql/irToAlgebra.ts` (P4).

## Tasks

### Dependency graph / parallelization
Phases are **sequential by commit** (one commit each) but independent in content, except P2 and P4 both edit `irToAlgebra.ts` — so they must run in order, not in parallel, to avoid conflicts. Chosen order P1 → P2 → P3 → P4 (lowest-risk config first, perf last). No sub-agent parallelism warranted (small, single-file-per-concern edits; the risk is in validation, not throughput). Every phase's acceptance gate is identical: `npm run compile` exits 0 **and** `npm test` shows **1444 passed, 117 skipped, 5 snapshots passed** (the frozen baseline).

### Phase 1 — Dependency + build-config leanness ✅ DONE
Result: compile exit 0; `npm test` = 1444 passed / 117 skipped / 5 snapshots (exact baseline). Emit checks: no `lib/esm/test-helpers`, `index.js` present, no `__metadata(` in `List.js`. No deviations.
Tasks: (a) drop `next-tick` dep + fix `types` field in `package.json`; (b) `tsconfig.json` exclude test-helpers, remove `emitDecoratorMetadata`/`downlevelIteration`/`jsx`, prune phantom `include` entries; (c) remove `testPathIgnorePatterns` in `jest.config.js`.
Validation (quick gate = full gate):
- `npm run compile` → exit 0, no TS errors.
- `npm test` → 1444 passed / 117 skipped / 5 snapshots — **exact match** to baseline.
- Structural: `npx tsc -p tsconfig-esm.json` then assert `lib/esm/test-helpers` does **not** exist and `lib/esm/index.js` does; assert no `__metadata(` string appears in `lib/esm/shapes/List.js` (decorator-metadata no longer emitted).

### Phase 2 — Internal dead code + unused imports ✅ DONE
Result: compile exit 0 (proves no dangling refs); `npm test` = 1444/117/5 (exact baseline). Structural: no `utils/Types` refs, dead `irToAlgebra` imports gone. No deviations.
Tasks: delete `src/utils/Types.ts`; strip the five unused imports/comment listed in the plan.
Validation:
- `npm run compile` → exit 0 (compilation failure here would prove a symbol was NOT dead — treat as a stop-and-report deviation).
- `npm test` → exact baseline match.
- Structural: `grep -rn "utils/Types" src/` → zero hits; `git grep -n "SparqlDeleteWherePlan\|deleteWherePlanToSparql" src/sparql/irToAlgebra.ts` → zero hits.

### Phase 3 — Remove `canonicalizeWhere` no-op ✅ DONE
Result: compile exit 0; `canonicalizeWhere` fully removed (0 refs); `npm test` = 1444/117/5 (exact baseline, incl. `ir-canonicalize`/`lower`/all golden suites green).
**Deviation (minor):** a **4th** call site existed beyond the planned three — `IRLower.ts:432` (`inlineFilterHandler`), where `where: DesugaredWhere` is passed straight to `lowerWhere`. Handled identically (identity inline + import drop); behavior-preserving. Original grep scoped to lower/lowerMutationJSON/IRPipeline missed it; the compile gate surfaced it.
Tasks: delete `canonicalizeWhere`, inline its 3 call sites, drop 2 now-unused imports, keep the 3 types + `canonicalizeDesugaredSelectQuery` (with its minusEntries reshaping).
Validation:
- `npm run compile` → exit 0.
- `npm test` with attention to: `ir-canonicalize.test.ts`, `lower.test.ts`, `ir-select-golden.test.ts`, `sparql-select-golden.test.ts`, `sparql-mutation-golden.test.ts` — all green; overall exact baseline match.
- Structural: `grep -rn "canonicalizeWhere" src/` → zero hits (fully removed).

### Phase 4 — Hot-path memoization ✅ DONE
Result: compile exit 0; `npm test` = 1444/117/5 (exact baseline, incl. `sparql-*-golden`, `property-path-*`, `shacl-cascade`, `store-routing`). Verified callers of `collectContainment` are read-only (no push/splice/sort), so sharing the cached object is safe. No deviations.
Tasks: add size-guarded `predicateTermCache` to `resolvePropertyPredicateTerm` (cache successes only); memoize `collectContainment` with the same size guard.

### Integration check ✅ DONE
`npm run build` (rimraf + cjs + esm + dual-package) exit 0. Artifact: no `test-helpers/` in `lib/esm` or `lib/cjs`; `lib/esm/index.d.ts` present (matches fixed `package.json` `types`); `Types.js` gone. Cross-phase interaction on `irToAlgebra.ts` (P2 + P4) clean.
Validation:
- `npm run compile` → exit 0.
- `npm test` → exact baseline match; specifically `sparql-select-golden`, `sparql-mutation-golden`, `property-path-sparql`, `property-path-integration`, `shacl-cascade`, `store-routing` green (these exercise multi-shape registries + cascades, where a stale cache would show).
- Edge case to reason about (not a coded test, argued in the plan): a shape registered *after* a query in the same module instance → size guard clears the cache; not-found predicates are never cached, so late registration still resolves. No golden test regresses.

### Integration check (end of P4)
After the last phase, run the whole suite once more clean (`npm run compile && npm test`) and confirm the published-artifact shape via `npm run build` (rimraf + cjs + esm + dual-package) exits 0 and produces `lib/` without `test-helpers/`. This catches cross-phase interaction (P2 and P4 both touched `irToAlgebra.ts`).
