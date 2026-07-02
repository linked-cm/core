---
summary: Deferred security items from the hardening pass (report 023) — property-path prefixed-name grammar validation (SEC4) and a doc/guard note for loadStores' config-driven dynamic import (SEC6). The two critical injection vectors and the medium var/DoS/proto items are already fixed.
packages: [core]
---

# 008 — Remaining SPARQL-injection hardening

> Source: deferred from report 023 (security hardening), findings SEC4 & SEC6.
> SEC1/SEC2 (critical) and SEC3/SEC5/SEC7 are fixed on the same thread.

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
(e.g. a dynamic `.traverse(userPath)` or a `{path}` in wire JSON).

**Fix:** validate the prefixed-name against the SPARQL `PN_PREFIX ':' PN_LOCAL`
grammar (`[A-Za-z_][\w.-]*:[\w.\-%]*` roughly), reject anything else; route full
IRIs through `formatUri`. Add tests mirroring `security-injection.test.ts`.

## SEC6 (Low) — loadStores dynamic import
`src/utils/loadStores.ts:47` `await import(entry.store)` loads an arbitrary
module path from `datasets.json`. Arbitrary-module-load / code-exec **if an
attacker controls that config** — a trusted developer artifact, so Low.

**Action:** documentation note that `store` must never be attacker-influenced;
optionally validate the specifier against an allowlist/prefix. No code change
strictly required.

## Recommendation
Do SEC4 next when touching the paths layer (small, self-contained, testable).
SEC6 is a doc note.
