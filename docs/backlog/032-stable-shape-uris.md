---
summary: Derive shape URIs from a stable identifier instead of the runtime `constructor.name`, so bundler class-renaming (duplication or production minification) can never break cross-runtime shape identity.
---

# 032 — Stable shape URIs (decouple from `constructor.name`)

## Problem

A shape's URI is derived from the **runtime class name** at registration time:

```ts
// packages/core/src/utils/Package.ts:311
new NodeShape(getNodeShapeUri(packageName, constructor.name))
// packages/core/src/shapes/SHACL.ts:983
// → `{baseUri}shape/{packageSlug}/{ShapeName}`   e.g. …/shape/_linked-schema/Person
```

`constructor.name` is **not stable under bundling**:

- **Duplication** — when a bundler emits more than one copy of a class in a scope
  (e.g. Vite's dep-optimizer pre-bundling `@_linked/core` into multiple per-subpath
  chunks), JS can't have two `Person` classes in one scope, so the copies are renamed
  `Person`, `Person2`, `Person3`. Each registers under a different URI.
- **Minification** — production builds may rename classes (`Person` → `a`), and two
  runtimes (browser bundle vs Node backend) can minify differently.

Because the browser (client) and the Node backend are **two separate runtimes** that
must agree on shape identity (e.g. `BackendAPIStore` query forwarding sends the shape
URI over `/call/:scope/:pkg/:shape/:method`), any divergence in the name breaks the
lookup: `getShapeClass(mangledURI)` misses and the call no-ops/crashes.

The duplication half is currently avoided at the **build** layer (cli vite-config
`optimizeDeps.exclude` keeps `@_linked/core` single-instance so `constructor.name`
stays `Person`). That works, but it's a build-time guarantee about a bundler's
behavior — fragile, and it does nothing for **production minification**.

## Proposed direction

Derive the shape URI from a **stable, declared** identifier rather than the runtime
class name, so no bundler transform can change it:

- Option A — the `@linkedShape` decorator takes an explicit `name`/`id` (falls back to
  `constructor.name` only when omitted, with a dev warning). Explicit is authoritative.
- Option B — derive from `static targetClass` (an IRI) where present; it's already a
  stable identifier for many shapes.
- Option C — a build-time transform stamps a stable name onto each `@linkedShape` at
  compile time (before any minifier runs).

Whichever is chosen, `getNodeShapeUri(packageName, stableName)` becomes independent of
`constructor.name`, and the build-layer `optimizeDeps.exclude` workaround +
`callShapeMethod`'s defensive guard become belt-and-suspenders rather than load-bearing.

## Impact / scope

- Touches every shape's registration path (`Package.ts`, `SHACL.ts` `getNodeShapeUri`,
  the `@linkedShape` decorator).
- Needs a migration story for existing serialized URIs (the URI string changes only if
  the declared name differs from `constructor.name`; for most shapes it wouldn't).
- Unblocks removing the standalone `optimizeDeps.exclude` reliance and makes prod
  minification safe.

## Additional design notes

- **Concrete decorator API (Option A, preferred).** `@linkedShape` gains an optional
  explicit name: `@linkedShape('Person')` or `@linkedShape({ name: 'Person' })`. When
  present it's authoritative for `getNodeShapeUri`; when absent, fall back to
  `constructor.name` **and emit a one-time dev warning** ("shape X has no explicit
  linkedShape name — its URI depends on `constructor.name` and may break under
  minification/duplication"). This gives an incremental migration (annotate hot shapes
  first) without a big-bang change.

- **Registration is the only place to change.** All URI derivation funnels through
  `getNodeShapeUri(packageName, name)` (SHACL.ts) called from `Package.ts` registration.
  If the decorator captures the stable name and passes it here, nothing downstream
  (serialization `{__s,u}`, `getShapeClass` lookup) needs to change — they already key
  off whatever string registration produced.

- **Dev-time drift detection.** Add an optional dev check that hashes each registered
  shape's `(packageName, name)` and warns if two different constructors register the
  same URI, or if a URI carries a numeric suffix (`…/Person2`) — a cheap early signal
  that duplication/minification is mangling identity in a given build, instead of a
  silent no-op at query-forward time.

- **Production minification is the real prize.** The build-layer `optimizeDeps.exclude`
  fix only addresses *duplication* in dev. A production bundle that minifies class names
  (`Person`→`a`) would reintroduce the exact mismatch, independently per runtime. Stable
  declared names make identity **transform-proof**, at which point `optimizeDeps.exclude`
  and `callShapeMethod`'s null-guard become belt-and-suspenders rather than load-bearing.

- **Relationship to [[033-no-live-shape-instances]].** Stable URIs (this doc) fix shape
  *identity across serialization*; 033 removes live shape *instances* from crossing
  boundaries at all. Complementary: 033 shrinks the surface that 032 must keep stable.

## Origin

Surfaced during CN Phase 1.5 case-A (true standalone app) app-UI-CRUD: Vite dep-optimizer
duplicated `@_linked/core` in the browser bundle → `Person`/`BackendAPIStore` renamed →
shape-URI mismatch with the backend. Fixed at the build layer via `optimizeDeps.exclude`;
this backlog captures the deeper, transform-proof fix.
