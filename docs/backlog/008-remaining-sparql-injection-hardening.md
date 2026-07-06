---
summary: Deferred security item from the hardening pass (report 023) — property-path prefixed-name grammar validation (SEC4). The two critical injection vectors and the medium var/DoS/proto items are already fixed; SEC6 (loadStores dynamic import) is now covered by an inline security note in the code.
packages: [core]
---

# 008 — Remaining SPARQL-injection hardening

> Source: deferred from report 023 (security hardening), finding SEC4.
> SEC1/SEC2 (critical) and SEC3/SEC5/SEC7 are fixed on the same thread. SEC6
> (loadStores config-driven dynamic import) was resolved with an inline security
> note in `src/utils/loadStores.ts` — the specifier must never be
> attacker-influenced; a runtime allowlist is optional and not required.

## SEC4 (Medium) — property-path prefixed-name validation
`src/paths/pathExprToSparql.ts` `refToSparql`: a string path ref containing
`://` now routes through the hardened `formatUri` (SEC1) and is safe. But a ref
**without** `://` is emitted 100% verbatim as a "prefixed name":

```ts
if (ref.includes('://')) return formatUri(ref); // hardened
return ref;                                      // prefixed-name: verbatim
```

So a path token like `foo ; DROP` (or a crafted prefixed name) is still emitted
raw. Usually paths are decorator-defined (developer-controlled), hence Medium
not Critical — exploitable only if property paths are built from untrusted input
(e.g. a dynamic `.traverse(userPath)` or a `{@path}` in wire JSON).

**Fix:** validate the prefixed-name against the SPARQL `PN_PREFIX ':' PN_LOCAL`
grammar (`[A-Za-z_][\w.-]*:[\w.\-%]*` roughly), reject anything else; route full
IRIs through `formatUri`. Add tests mirroring `security-injection.test.ts`.

## Recommendation
Do SEC4 next when touching the paths layer (small, self-contained, testable).
