---
summary: Repository-wide analysis of @_linked/core — simplification/leanness opportunities, security (SPARQL injection) findings, functional inconsistencies & gaps, and future directions. Analysis only; no code changed. Baseline 1444 tests passing.
packages: [core]
---

# 021 — Repo Analysis: Simplification, Security, Gaps, Future Directions

Baseline verified before analysis: `npm test` → **1444 passed, 117 skipped** (51/54 suites; 3 Fuseki suites skipped without Docker). All headline findings below were spot-checked against source. No files were modified.

Priorities, as requested: **1) simplification/leanness · 2) security · 3) inconsistencies/gaps · 4) future directions.**

---

## 1. Simplification / cleanup / performance

Conservatively **~950–1150 lines removable at high confidence** plus one unused runtime dependency, two genuine bug fixes, and one packaging fix — all without changing public behavior.

### Highest value

| # | Item | Where | Impact |
|---|---|---|---|
| S1 | **Published package ships `src/test-helpers/`** — tsconfig `exclude` only lists `./src/tests/**`, so FusekiStore/query-capture-store/etc. compile into `lib/` and are published via `"files":["lib"]`. `query-capture-store.ts` imports `@jest/globals` (a devDep → unloadable for consumers); `fuseki-test-store.ts` pulls in `child_process`. | `tsconfig.json:26`, `src/test-helpers/*` | **1-line fix**, removes broken modules from every published artifact |
| S2 | **Bug: `NodeShape.type` predicate clobbered to `sh:description`** — `Package.ts:621` registers label `'type'` a 2nd time with `path: shacl.description`; `registerPropertyShape` does `Object.assign(existing, …)`, so the meta-shape's `type` ends up pointing at `sh:description` instead of `rdf:type`. Label was meant to be `'description'`. | `utils/Package.ts:621-624`, `shapes/SHACL.ts:638` | Delete 4 lines; fixes wrong-predicate bug |
| S3 | **Unused runtime dependency `next-tick`** — zero imports anywhere. (`ulid` IS used — keep.) | `package.json:64` | Drop 1 of 2 runtime deps |
| S4 | **PERF: `resolvePropertyPredicateTerm` scans the whole ontology per predicate** — iterates `getAllShapeClasses()` + `getPropertyShapes(true).find(...)`; **10 call sites**, no memoization. | `sparql/irToAlgebra.ts:106-128` | Add a `Map<propertyId, term>` cache → O(1); biggest SPARQL-layer perf lever |
| S5 | **PERF: `collectContainment()` recomputed per cascade inside loops** — full registry scan re-run per removed/replaced/deleted item. | `sparql/irToAlgebra.ts:2041-2062` (loops at :1766/:1894/:2138) | Hoist to once per conversion |
| S6 | **`IRCanonicalize` is a self-documented no-op pass** — `canonicalizeWhere` returns input in both arms ("With the Evaluation class retired, this is now a passthrough"). Runs on every query + copies each query object. | `queries/IRCanonicalize.ts` (61 lines) | Collapse to type aliases, drop the pipeline step (~55 lines + per-query copy) |

### Dead code (verified unused across `src/` incl. tests)

- **`utils/ShapeClass.ts`** — ~90 lines: `getShapeOrSubShape`/`getMostSpecificShapes`/`getMostSpecificShapesByType` (throw-only stubs), `_getMostSpecificShapes` + its cache, `isClass`, 13 lines commented-out.
- **`utils/Types.ts`** — entire 19-line file, zero importers.
- **`SelectQuery.ts`** — `convertOriginal` (~46), `getOriginalSource` overloads (~55), `setSource`/`filter`, plus ~65 lines of dead exported conditional types (`QueryController`, `NodeResultMap`, `GetSource`, `QueryArg`/`ArgPath`, `ResponseToObject` chain…). ~175 lines total.
- **`paths/serializePathToSHACL.ts`** — 163 lines, imported only by tests; production sync uses the parallel `serializePathToNodeData`. Two serializers kept in lockstep.
- **Assorted:** `QueryFactory.checkNewCount` (~20), `resultMapping.isUriExpression` (~11), `IRProjection.buildCanonicalProjection` (test-only ~35), `IRAliasScope` scope-chain half (test-only ~30), `WhereCondition.ts` (placeholder), unused imports in `irToAlgebra.ts:23,40`, `Shape.ts:10`, `Expr.ts:89`, `SHACL.ts:9`.
- **Write-only registries / no-op accessors:** `Shape.typesToShapes`+`registerByType` (~25, never read), `NodeShape.nodeRef`/`validateNode`/`equals`, `_label` get/set pairs, `NodeShapeConfig`/`ParameterConfig`/`PropertyPathInput` unused types (~120 total; some on public classes → "public API, unused internally").

### Duplication worth unifying

- **Mutation builders (Create/Update/Delete)** triplicate the Promise interface (`then/catch/finally`, byte-identical), `clone()`, `fromJSON` preamble, and the where-path resolution block (appears 4×). An abstract base removes **~120-150 lines** + three-way drift risk.
- **DSL-JSON value decoders duplicated** — `lowerMutationJSON.decodeValue/decodeNodeData` vs `MutationSerialization.decode*ToRaw` walk the same tag grammar; every new wire tag must be added twice (already drifting on `{list}`/`{$ctx}`). ~60-80 lines.
- **`lower.ts` vs `lowerMutationJSON.ts`** ~80% parallel dispatch onto the same six builders.
- **Inside `irToAlgebra.ts`:** predicate-term ternary copied 4× (extract `buildPredicateTerm()`), `deleteAllToAlgebra` ≈ `deleteWhereToAlgebra`, seven mechanical `*ToSparql` wrappers (two with stale "Stub: will be implemented" JSDoc). `resultMapping.mapSparqlUpdateResult` re-implements `populateRowFromNodeData`.
- **`CoreSet`/`CoreMap`** — ~80 lines of unused methods; the two in-scope non-ShapeSet users (`Prefix`, `LinkedStorage`) only call native Map/Set methods. `CoreMap.map` claims return type `this` but returns a different value type (type lie).

### Config / build leanness

- `tsconfig.json`: `emitDecoratorMetadata:true` with no `reflect-metadata` consumer (emits dead `__metadata` into every decorated class); `jsx:"react"` (no `.tsx`); phantom `include` paths (`../node_modules/ts-jest/globals.d.ts`, `../../node_modules/@types/*`); `types:["node","jest"]` bakes jest into the published build; `downlevelIteration` no-op at es6.
- `package.json`: `"types":"./index.d.ts"` → file doesn't exist; `sync:agents` → `packages/skills/sync.mjs` doesn't exist; `jest.config.js` `testPathIgnorePatterns:['/old/']` → no such dir.
- **Correctness-adjacent:** `Prefix._toFull` uses `split(':')` and drops everything after the 2nd colon (wrong expansion for local names with colons — 2-line fix). `utils/cached.ts` keys only on `JSON.stringify(args)` (different fns collide), never evicts expired entries (unbounded Map), and returns cached errors as values instead of rethrowing.

---

## 2. Security

The library builds SPARQL text from a typed DSL **and** from `fromJSON()` wire input (documented as "the inbound boundary" — entirely attacker-controlled). Both funnel into `algebraToString.ts` / `sparqlUtils.ts`.

### Critical — SPARQL injection

- **SEC1 (CRITICAL): unvalidated IRIs.** `formatUri` (`sparqlUtils.ts:14`) wraps any string as `<${uri}>` with **zero validation** — no rejection of `>`, spaces, newlines, `{}`. A `URI.isURI` regex exists (`utils/URI.ts:24`) but is **never called anywhere**. Every IRI sink routes here (subjects, node ids, datatypes, GRAPH/VALUES). A node id like `http://x/a> } ; DROP ... ` closes the IRI and injects raw SPARQL. Because `SparqlDataset.updateQuery/deleteQuery` POST to `/update`, this is **update injection** (read/modify/delete), reachable from both the typed API (if a consumer forwards untrusted `?id=`) and directly from `fromJSON`. *Verified: `formatUri` does no validation; `isURI` has zero callers.*
- **SEC2 (CRITICAL): unescaped function names.** `algebraToString.ts:127` emits `function_expr` as `${expr.name}(...)` with no allowlist; `headToIR` (`DslJsonExpression.ts:230`) turns **any** unknown S-expr head into a verbatim function name. From `fromJSON`, an S-expr head `"a() . } ; DELETE WHERE { ?s ?p ?o } #"` injects cleanly — the *cleanest* primitive since (unlike IRIs) it needs no breakout char. *Verified reachable from wire input.*

### Lower severity

- **SEC3 (MED): variable/alias names** emitted raw as `?${name}`; `sanitizeVarName` exists but is applied only to property-derived vars in the registry, not to alias/projection/root names (`algebraToString.ts` many sites).
- **SEC4 (MED): property-path strings** — `pathExprToSparql.refToSparql` emits prefixed-name refs 100% verbatim and IRIs via the unvalidated `formatUri`.
- **SEC5 (LOW/MED): unbounded recursion DoS** — DSL-JSON decoders (`lowerMutationJSON`, `DslJsonExpression`) and `serializeAlgebraNode` recurse with no depth cap → stack overflow from a deeply-nested `fromJSON` payload.
- **SEC6 (LOW): `loadStores.ts:47`** dynamic `import(entry.store)` of a config-supplied specifier (arbitrary module load if config is attacker-controlled — trusted-artifact caveat; doc it).
- **SEC7 (LOW/INFO): `MutationSerialization.decodeNodeDataToRaw`** assigns `obj[key]` without filtering `__proto__` — local temp object only (not global pollution), but unhygienic; use `Object.create(null)`.

**Verified safe (for calibration):** string-literal escaping (`escapeSparqlString`) correctly covers `\ " \n \r \t` — literal *values* are not injectable; the injection surface is IRIs and names. No ReDoS (all regexes linear; path parser is single-pass). `files` whitelist doesn't leak `src`. `next-tick`/`ulid` low-risk. No `eval`/`Function`.

**Priority fixes:** (1) central IRI validation/escaping in `formatUri`; (2) allowlist function/aggregate names in `headToIR`; (3) apply `sanitizeVarName` at every `?${}` emission; (4) recursion-depth cap in decoders.

---

## 3. Inconsistencies & gaps in functionality

### Tier 1 — silent wrong results / broken primary docs

- **G1: nested arithmetic loses precedence.** `binary_expr` serializes as `left op right` with **no parentheses** (`algebraToString.ts:105`); only OR-inside-AND and `not` are grouped. `Expr.plus(a,b).times(c)` → `?a + ?b * ?c`, parsed as `a + (b*c)` — **silently wrong numbers**. A comparison-in-comparison emits a SPARQL *syntax error*. No test composes arithmetic through to SPARQL. *Verified in serializer.*
- **G2: `documentation/dsl-json.md` (the canonical spec + LLM-authoring prompt) documents grammar the decoder doesn't implement** — relation-keyed projection forms `{"friends":["name"]}`, trailing method calls in paths `"friends.size()"`, explicit `{equals:…}` operand form, `in`/`nin` + `{list}`, nested `some`-of-`some`, casts in conditions, `fields:"*"`. These throw or silently decode to nonsense filters. Anyone (human or LLM) hand-authoring from the spec produces broken payloads.
- **G3: README quickstart is broken** — `LinkedStorage.setDefaultStore`/`setStoreForShapes` don't exist (real: `setDefaultDataset`/`setDatasetForShapes`); `LinkedStorage` and `Shape` aren't re-exported from the package root; `@_linked/core/sparql` subpath doesn't resolve; README DSL-JSON examples use pre-2.10.1 wire.
- **G4: computed expressions silently dropped in `create`** (work in `update`) — `generateNodeDataTriples` has no `IRExpression` branch, so `Person.create({createdAt: Expr.now()})` persists nothing for that field, no error. Nested-create update also drops the traversal collector.
- **G5: SHACL constraints declared but ignored** — nine options (`minExclusive/…/pattern/languageIn/uniqueLang`) plus `order`/`group` are accepted by the decorator config type but never read by `createPropertyShape`; no field, no serialization, no warning. Plus the `type`→`sh:description` clobber (S2). `defaultValue`/`sortBy` held in memory but never synced.

### Tier 2 — crashes / silent loss on valid-looking input

- **G6:** wire `null` mutation value → `isSetModification(null)` throws `TypeError` (builder path treats `null` as unset — two behaviors, same input).
- **G7:** `isSetModification` precedence bug (`MutationQuery.ts:70`) — `{friends:{add:[…], name:"x"}}` silently discards `name`; mirror `remove` case throws a confusing error. Same concept has a second, differently-behaving impl (`isSetModificationValue`).
- **G8:** reserved value-key collision — a property labeled `date`/`path`/`id` collapses a nested node into a single value (guard only covers `and/or/not`).
- **G9:** multi-key sort applies only the first entry's direction to all paths (`[{"name":"ASC"},{"age":"DESC"}]` sorts age ascending).
- **G10:** nested-select pagination (`innerLimit/innerOffset/innerOrderBy`) is lowered to SPARQL but **not emitted by `FieldSet.toJSON()`** — serialize→rehydrate silently returns the unbounded set.

### Tier 3 — feature asymmetries

- **G11:** aggregates — IR/SPARQL/wire support `count|sum|avg|min|max`, DSL exposes only `.size()`→count; `SetSize` supports only `.equals()` (no `.gt()`), though HAVING pipeline handles any comparison. (Tracked: backlog 006.)
- **G12:** `Expr` static module vs `ExpressionNode` methods drift — naming (`Expr.regex` vs `.matches`, `Expr.bound` vs `.isDefined`) and missing counterparts (`Expr.now`/`Expr.ifThen` have no fluent form; `.isNotDefined` has no `Expr` form).
- **G13:** SHACL paths — `!(…)` negated sets parse & decorate fine but **throw at sync time**; there is **no SHACL→PathExpr reader** (serialization is one-way); empty/1-member seq/alt serialize to SHACL-invalid lists.
- **G14:** always-throwing exported functions typed with normal return types (should be `never`), e.g. `ShapeClass` stubs — no type-level signal they're unsupported.

### Tier 4/5 — error-handling inconsistency & TODOs

Same failure class handled as throw **vs** `console.warn`-and-continue **vs** silent, depending on module (catalogued). User-facing TODO gaps: no create-time shape validation (`CreateBuilder.ts:126`); plain-object update requires a decorator-declared value shape or throws; `in`/`nin` half-wired.

### Tier 6 — test coverage gaps

- **False-green Fuseki suites:** all 6 integration suites guard bodies with `if (!fusekiAvailable) return;` → **CI without Docker reports success while running none of them**. `SparqlDataset` is only reachable through these → effectively untested in normal CI.
- **Zero coverage, public API:** `loadStores`, `parseDatasetsConfig`, `initModularApp`, `ContextRef` surface, `LinkedErrorLogging`, `SelectBuilder` as a named export.

---

## 4. Future directions

Grounded in the existing `docs/ideas` + `docs/backlog` and the gaps above:

1. **Harden the wire boundary (security + correctness together).** The `fromJSON` path is both the top injection vector (SEC1/SEC2) and the top gap source (G2). A single "validate + canonicalize at the boundary" pass — IRI/name allowlisting, depth cap, and reconciling the decoder with `dsl-json.md` — closes both. Highest leverage.
2. **Close create/update parity and finish aggregates.** Expression-in-create (G4), `sum/avg/min/max` + `SetSize` comparisons (G11, backlog 006), and multi-key sort (G9) are all "IR/SPARQL already support it, only the DSL/codec lags" — cheap, high-visibility wins.
3. **Make SHACL constraints real or remove them.** Decide per option in G5 whether to serialize/sync it or drop it from the config type; add a `sh:path` reader so shape sync is bidirectional (G13). Aligns with idea 015 (SHACL RDF serialization).
4. **Fix the false-green CI.** Make Fuseki suites fail (or explicitly `skip`) when Docker is absent, so `SparqlDataset` regressions surface. Pairs with idea 010 (strictNullChecks) and the type-system refactor (idea 011) to raise the correctness floor.
5. **Leanness pass as a standalone PR.** The dead-code + dependency + build-config cleanups in §1 are low-risk, test-covered, and shrink both the published artifact and tsc load — a good first merge to de-risk the larger changes.
6. **Named-graph / CONSTRUCT support** (ideas 004/005) remain the biggest genuinely-missing capabilities for multi-tenancy and provenance use cases.

---

### Suggested sequencing
Security boundary hardening (SEC1-2, G2) → create/update parity + aggregates (G4, G11, G9) → SHACL constraint reconciliation (G5, S2) → leanness/dead-code PR (§1) → CI/test-integrity fix (Tier 6). The leanness PR can land first as it's the lowest-risk and unblocks cleaner diffs for the rest.
