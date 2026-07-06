---
summary: Behavior-preserving simplification & leanness pass over @_linked/core (report 022 §1) plus follow-up iterations — dead code, unused dependency, build-config bloat, a no-op IR pass, hot-path memoization, three real bug fixes, duplication extractions, CoreMap→native Map, a public-surface prune, and a new TypeScript compile gate for the query result-type inference. Production source ended at 17,605 lines; ~790 net lines removed; full suite green throughout.
packages: [core]
status: Report
source_report: docs/reports/022-repo-analysis-cleanup-security-gaps.md (section 1)
---

# 023 — Simplification & Leanness (wrap-up)

Delivered from report 022 §1 and the review iterations that followed. **Constraint held throughout:** same functionality, all tests passing; the full suite (later + a typecheck gate) was the acceptance gate after every phase. No existing test was modified without evidence; behavior-changing fixes got new lock-in tests.

## Outcome
- **Production source: 79 files, 17,605 lines** (everything reachable from `src`/`index.ts`, excluding tests + test-helpers).
- **Net change across the whole effort: +168 / −959 = ~790 lines removed**, plus one runtime dependency (`next-tick`) gone.
- Final suite: **1,446 jest tests + typecheck**, clean `npm run build`, artifact no longer ships `test-helpers`.

## What landed

### Baseline behavior-preserving pass (Phases 1–4)
1. **Dependency + build config:** removed `next-tick`; fixed `package.json` `types` → `./lib/esm/index.d.ts`; excluded `src/test-helpers/**` from the build (was shipping modules importing `@jest/globals`/`child_process`); dropped `emitDecoratorMetadata`/`jsx`/`downlevelIteration`/phantom includes; removed `jest.config` `testPathIgnorePatterns`.
2. **Internal dead code:** deleted `utils/Types.ts` + five unused imports/comment.
3. **`canonicalizeWhere` no-op:** removed the provable identity indirection (4 call sites; a 4th beyond the planned 3 was surfaced by the compile gate).
4. **Hot-path memoization:** `resolvePropertyPredicateTerm` and `collectContainment` — per-predicate/per-cascade full-ontology scans → O(1), guarded by registry size. Golden SPARQL byte-identical.

### Iteration — Gap 1 bug fixes (behavior-changing, with lock-in tests)
- `NodeShape.type` predicate un-clobbered (`Package.ts` copy-paste registered `'type'` twice → `sh:description`; now correctly `rdf:type`).
- `Prefix._toFull` splits on the first colon (local names with colons no longer truncated).
- `cached()` — per-function `WeakMap` cache (no cross-fn collisions, bounded growth) and re-throws cached errors instead of returning them as values.
- New `src/tests/gap1-fixes.test.ts`.

### Iteration — Gap 3 duplication (safe extractions)
- `MutationThenable<R>` base class removes the byte-identical thenable blocks from the three mutation builders.
- `buildPredicateTerm()` folds four identical predicate-term ternaries in `irToAlgebra.ts`.
- Deferred (too risky for the gate): decoder unification, `lower.ts`/`lowerMutationJSON.ts` merge → **backlog 007**.

### Iteration — CoreMap → native Map
Removed `CoreMap` (used in 3 spots, only via native `Map` methods) and the dead `NodeResultMap` alias. **CoreSet retained** (load-bearing: `ShapeSet extends CoreSet`; `SelectQuery` uses `.first()`/`.concat()`).

### Type-inference compile gate (new safety net)
Fixed `tsconfig-tests.json` to compile standalone; added a `typecheck` script (`tsc -p tsconfig-tests.json`) covering the `*.types.test.ts` inference tests **and** the previously-orphaned `type-probe-*.ts`; wired it into `npm test`. **Proven to catch result-type regressions.** This made the public-surface prune provably safe.

### Iteration — Gap 2 public-surface prune (breaking, ~600 lines)
Removed `initModularApp` + the `window/global._linked` dump and its ~40 namespace imports; `ShapeClass` throw-only stubs + dead cache/helpers; `QueryFactory.checkNewCount`; `resultMapping.isUriExpression`; `WhereCondition.ts`; `serializePathToSHACL.ts` (+ its test-only suite); `SelectQuery` dead methods (`convertOriginal`, `getOriginalSource`, `filter`, `setSource`, `isSource`) and 14 dead result-type aliases. Verified via the typecheck gate that the live inference (`QResult`/`GetQueryObjectResultType`/`ObjectToPlainResult`/`AccessorReturnValue`) is untouched. None of the removed code was in the documented API.

## Breaking changes (for the changeset — warrants a major bump)
Removed public surface that was never in the documented API but was technically reachable: the `_linked` global (`initModularApp`), `@_linked/core/collections/CoreMap`, `WhereCondition`/`WhereOperator` type exports, `serializePathToSHACL`, and assorted `SelectQuery`/`ShapeClass`/`QueryFactory` internals.

## Deferred → backlog
- **007** — decoder & lowering unification (remaining Gap 3).
- **009** — Fuseki false-green CI/test integrity (review Gap 4).
