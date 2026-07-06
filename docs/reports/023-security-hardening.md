---
summary: Security hardening from report 021 §2 — closed both critical SPARQL-injection vectors (unvalidated IRIs, unescaped function names) and added variable-name sanitization, a decoder recursion cap, and prototype-key hygiene. All fixes validate only at the SPARQL-emission boundary and reject only malicious input, so valid queries are byte-identical and no existing test changed. 8 new security tests. SEC4/SEC6 deferred to backlog 008.
packages: [core]
status: Report
source_report: docs/reports/021-repo-analysis-cleanup-security-gaps.md (section 2)
---

# 023 — Security Hardening (wrap-up)

Delivered from report 021 §2. **Design principle:** validate at the SPARQL-emission trust boundary (`sparqlUtils`/`algebraToString`) so every input path (typed DSL + `fromJSON`) is covered, and reject **only** malicious input — valid IRIs, builtin functions, and normal variable names pass unchanged, keeping golden SPARQL byte-identical. New tests lock each fix; **no existing test was modified**.

## Fixed

| # | Sev | Issue | Fix |
|---|---|---|---|
| SEC1 | **Critical** | `formatUri` emitted `<${uri}>` with zero validation → IRI-breakout SPARQL/UPDATE injection | `assertSafeIri()` rejects forbidden IRIREF chars (`<>"{}\|^\`\\`, space, control) before both branches |
| SEC2 | **Critical** | `function_expr`/`aggregate_expr` names emitted verbatim; `fromJSON` turns any S-expr head into a function name | `assertSafeCallName()` — SPARQL 1.1 builtin allowlist at the emission chokepoint |
| SEC3 | Medium | variable/alias names emitted raw `?${name}` | `sanitizeVarName` at all 9 `?${}` emission sites |
| SEC5 | Low/Med | DSL-JSON decoders recursed with no depth cap (stack-overflow DoS) | 128-level depth guard on `decodeValue`/`decodeValueToRaw`/`decodeValueExpr` |
| SEC7 | Low | `decodeNodeDataToRaw` assigned keys without proto guard | skip `__proto__`/`constructor`/`prototype` |

Files touched: `src/sparql/sparqlUtils.ts`, `src/sparql/algebraToString.ts`, `src/queries/lowerMutationJSON.ts`, `src/queries/MutationSerialization.ts`, `src/queries/DslJsonExpression.ts`. Tests: `src/tests/security-injection.test.ts` (8 cases: attacks throw, valid input unchanged).

## Validation
Full suite **1,446 jest + typecheck** green after each of the three phases; every legitimate function name the DSL uses was already in the allowlist (no test flipped); golden SPARQL byte-identical.

## Deferred → backlog 008
- **SEC4 (Medium)** — property-path *prefixed-name* verbatim emission still needs a `PN_PREFIX:PN_LOCAL` grammar check (IRI refs in paths are already covered by SEC1's hardened `formatUri`).
- **SEC6 (Low)** — `loadStores` dynamic `import()` of a config specifier: trusted-config, doc note only.
