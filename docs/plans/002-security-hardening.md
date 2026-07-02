---
summary: Security hardening from report 021 §2 — SPARQL-injection fixes (IRI validation, function-name allowlist, variable-name sanitization) plus decoder recursion cap and prototype-key hygiene. All fixes reject only malicious input at the SPARQL-emission chokepoint, so valid queries stay byte-identical and golden tests pass. New security tests lock each fix.
status: Plan
source_report: docs/reports/021-repo-analysis-cleanup-security-gaps.md (section 2)
packages: [core]
---

# 002 — Security Hardening

Constraint (same as prior threads): existing tests stay green (valid input is unaffected); new tests lock the security behavior; existing tests changed only with user sign-off.

## Scope & ranking (what we can address)

| # | Finding | Sev | Fix | Test risk |
|---|---|---|---|---|
| SEC1 | `formatUri` emits `<${uri}>` with zero validation | **CRIT** | Reject forbidden IRIREF chars (`<>"{}\|^\`\\`, space, ctrl) at `formatUri` before both branches | none — valid IRIs unchanged |
| SEC2 | `function_expr`/`aggregate_expr` names emitted verbatim | **CRIT** | Allowlist SPARQL 1.1 builtins at the `algebraToString` emission chokepoint (covers fromJSON + direct-IR) | none — legit builtins pass |
| SEC3 | variable/alias names emitted raw `?${name}` | MED | Apply `sanitizeVarName` at every `?${}` emission in `algebraToString` | none — valid names are `[A-Za-z0-9_]` |
| SEC5 | DSL-JSON decoders recurse with no depth cap (DoS) | LOW/MED | Depth guard in `decodeValue`/`decodeValueToRaw`/`decodeValueExpr` | none — normal depth well under cap |
| SEC7 | `decodeNodeDataToRaw` assigns keys without proto guard | LOW | Build with `Object.create(null)` / skip `__proto__` | none |

Deferred: SEC4 (property-path prefixed-name grammar check) — partly covered by SEC1 for IRI refs; the prefixed-name path needs its own grammar validation, follow-up. SEC6 (`loadStores` dynamic import) — trusted-config; doc note only.

## Architecture / contract
No `docs/architecture`. The SPARQL-emission layer (`sparqlUtils.ts` `formatUri`, `algebraToString.ts`) is the single trust boundary to query text; validating there covers every input path (typed DSL and `fromJSON`). Golden SPARQL tests are the byte-identical contract for valid input.

## Phases
- **Phase 1 — SEC1 IRI validation** (`sparqlUtils.formatUri`) + `src/tests/security-injection.test.ts`.
- **Phase 2 — SEC2 function/aggregate allowlist** (`algebraToString`) + tests.
- **Phase 3 — SEC3 var sanitize + SEC5 recursion cap + SEC7 proto hygiene** + tests.

Each phase: `npm test` (jest + typecheck) stays green; new security tests assert malicious input throws and valid input is unchanged. One commit per phase.
