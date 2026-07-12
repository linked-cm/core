---
title: Disallow Shape instances — DSL uses proxies + guarded constructor
status: Review
branch: claude/shape-instantiation-prevention-4awjgt
---

# Disallow Shape instances

## Context / Problem

The query DSL is already class-and-proxy based: builders store only the Shape
*class* (`ShapeConstructor`), metadata lives statically on `SomeShape.shape`, and
query results are plain objects. Yet Shape *instances* are still created in a few
places — always as vestigial "metadata carriers" (proxy targets) whose accessor
logic is never invoked, plus the SHACL meta-model containers (`NodeShape` /
`PropertyShape`). A consumer who calls `new Person()` gets a broken object whose
decorated getters return their typing stubs (`''`, `null`) — a footgun.

Goal: make the DSL operate with zero Shape instances, and make `new Person()`
(any domain Shape) throw a clear error steering the consumer to the DSL.

## Findings (from exploration)

- **Proxy targets** (`ProxiedPathBuilder.ts:27`, `SelectQuery.ts:561/606/955/1203`,
  `Shape.mapPropertyShapes`, `QueryContext.ts:136`) read only: the class
  (`.constructor` / `.nodeShape`), `.id`, and `__queryContext*` stamps.
- **Metadata is fully static.** No instance is needed to read metadata.
- **`NodeShape`/`PropertyShape`** are Shape subclasses genuinely instantiated as
  containers; their class-ness is needed on the **static** side (DSL meta-shapes
  used write-only by `syncShapes` via `NodeShape.create/select`). No read-back path
  reconstructs instances from RDF. Zero `instanceof NodeShape/PropertyShape` checks.
- **3 `instanceof Shape`** sites: `getSetOf` (Shape.ts:251), `setQueryContext`
  (QueryContext.ts:119), `cached` (cached.ts:28).

## Route decision (SELECTED: R1, per explicit user direction)

Two routes were on the table:

- **R1 — Plain-object meta-model + unconditional throw (SELECTED).** Convert
  `NodeShape`/`PropertyShape` metadata containers to QResult-like plain objects
  (`NodeShapeData` / `PropertyShapeData`) + free functions, migrate all call sites
  and type annotations, then make the `Shape` constructor throw **unconditionally**.
- **R2 — Guarded constructor (rejected).** A `new.target` allowlist exempting the
  meta-shapes. Lower churn but leaves instances internally and keeps instance
  methods.

**Why R1:** The user explicitly chose the full conversion ("complete replacement of
all call types") after being shown R1's cost (~178 type-position + ~93 value-position
usages across 29 files). The metadata *is* conceptually the QResult of the
meta-shape — modelling it as a plain object is the coherent end state, and it lets
the constructor throw unconditionally with no allowlist/token special-case. A brief
R2 spike (allowlist guard) was started and is being reworked into R1; Phase 1
(`createShapeTarget` ghosts) is retained as-is (it is how the DSL builds proxy
targets for domain shapes without invoking the now-unconditional constructor).

Size measured during planning: 178 type-position + 93 value-position usages, 29
files; ~22 instance-method call sites; 3 construction factories.

## Accepted decisions

- **D1 — Proxy target = constructor-less ghost (revised from `ShapeRef`).**
  During implementation, a plain `ShapeRef` was found to ripple invasively through
  `ShapeSet<S extends Shape>`, `QueryShapeSet`, and `getLeastSpecificShapeClasses`,
  which all rely on proxy-target members being real `Shape`s exposing `.nodeShape`.
  Instead, replace each internal `new shapeClass()` / `new Shape()` proxy-target
  site with `Object.create(shapeClass.prototype)` via a helper `createShapeTarget()`.
  The ghost is a genuine prototype-linked `Shape` (so `.nodeShape`, `.constructor`,
  `ShapeSet`, `getLeastSpecificShape` work unchanged) that **never runs the
  constructor** — so it coexists with the D2 guard. Diff shrinks to ~6 sites; no
  changes to `QueryShape`/`QueryShapeSet` internals. Same end guarantee.
- **D2 — Unconditional throw.** After the meta-model no longer instantiates,
  `Shape`'s constructor throws unconditionally (no allowlist/token). The only way to
  produce a Shape-shaped object is `createShapeTarget()` (Object.create, internal).
- **D3 — Plain-object metadata (`NodeShapeData` / `PropertyShapeData`).** New
  standalone interfaces (NOT extending `Shape`), so plain object literals are
  assignable. `SomeShape.shape` and every property shape become these plain objects.
  All `NodeShape`/`PropertyShape` *type* annotations migrate to the `*Data` types.
- **D4 — Instance methods → free functions in `src/shapes/nodeShapeData.ts`**
  (`getPropertyShapes`, `getUniquePropertyShapes`, `getPropertyShape`,
  `propertyShapeToResult`, `nodeShapeEquals`, `addPropertyShape`,
  `clonePropertyShape`, plus `createNodeShapeData`/`createPropertyShapeData`
  factories). `NodeShape`/`PropertyShape` remain as static-only DSL handles
  (values): `static shape: NodeShapeData`, inherited static `create/select/...`,
  registry registration, `.prototype` for `createShapeTarget`. Never instantiated.

## Architecture

### `createShapeTarget()` (new, internal)
Add to `src/shapes/Shape.ts`:
```ts
/** Internal: a constructor-less prototype-linked Shape used only as a proxy /
 *  metadata-carrier target. Never runs the (guarded) constructor. Not exported
 *  from the package index. */
export function createShapeTarget<S extends Shape>(
  shapeClass: ShapeConstructor<S> | typeof Shape, id?: string,
): S {
  const obj = Object.create(shapeClass.prototype) as S;
  if (id !== undefined) obj.id = id;
  return obj;
}
```

### Proxy-target sites → `createShapeTarget()`
- `src/queries/SelectQuery.ts` `generatePathValue`: `new shapeClass()` (`:561`) and
  `new (Shape …)()` (`:606`) → `createShapeTarget(shapeClass)` / `createShapeTarget(Shape)`.
- `QueryShape.as()` (`:1203`) and `QueryShapeSet.as()` (`:955`): `new (shape)()` →
  `createShapeTarget(shape, existing.id)`.
- `src/queries/ProxiedPathBuilder.ts` (`:27`): `new shape()` → `createShapeTarget(shape)`.
- `src/queries/QueryContext.ts` (`:136`): `new (shapeType)()` → `createShapeTarget(shapeType, value.id)`,
  then stamp `__queryContextId`/`__queryContextName`. Keep the `value instanceof Shape`
  branch for now (harmless; instances become impossible only after D2 — a domain
  Shape can no longer be passed, but a NodeShape/PropertyShape still could).
- `src/shapes/Shape.ts` `mapPropertyShapes` (`new this()`) and `getSetOf`
  (`new this()`) → `createShapeTarget(this)`.

Note: `QueryShape`/`QueryShapeSet` internals, `get id()`, `.nodeShape`,
`getLeastSpecificShape`, and `cached.ts` are **unchanged** — the ghost is a real
`Shape`, so all instance-shaped reads keep working.

### Plain-object metadata + free functions (Phase 2)
- New `src/shapes/nodeShapeData.ts`: `NodeShapeData`/`PropertyShapeData` interfaces
  (standalone, not `extends Shape`) + the free functions + factories.
- `NodeShape`/`PropertyShape` (SHACL.ts): keep as classes for their **static** DSL
  role only. Remove instance methods and instance-field declarations used purely as
  data (the fields now live on the plain objects). `static shape: NodeShapeData`.
- Construction factories build plain objects:
  - `Package.ts:310` `applyLinkedShape` `new NodeShape(uri)` → `createNodeShapeData(uri)`.
  - `Package.ts:562` base `Shape.shape` → `createNodeShapeData(...)`.
  - `SHACL.ts:764` `createPropertyShape` `new PropertyShape()` → `createPropertyShapeData()`.
  - `PropertyShape.clone()` → `clonePropertyShape()` (spread).
- `Shape.shape` and `ShapeConstructor.shape` types → `NodeShapeData`.
- Migrate ~178 `NodeShape`/`PropertyShape` type annotations → `*Data`, and ~22
  instance-method calls → free-function calls.

### Constructor guard (src/shapes/Shape.ts) — unconditional
- `Shape` constructor throws unconditionally (no allowlist/token). Message:
  ``Cannot instantiate shape `${new.target?.name}` directly — shapes are metadata,
  not data. Use the DSL: ${name}.select(...) / .create(...) / .update(...) /
  .delete(...).``
- Remove the temporary `_instantiable` allowlist and the `Shape.allowInstantiation`
  calls in SHACL.ts once the meta-model no longer instantiates.

## Expected file changes

- `src/shapes/Shape.ts` — `createShapeTarget` (done, Phase 1), unconditional throw,
  `.shape` type → `NodeShapeData`.
- `src/shapes/nodeShapeData.ts` — NEW: interfaces + free functions + factories.
- `src/shapes/SHACL.ts` — `NodeShape`/`PropertyShape` become static-only handles;
  `createPropertyShape` builds plain objects; internal method calls → free functions.
- `src/utils/Package.ts` — factory calls build plain objects; internal calls migrated.
- ~26 other files under `src/queries`, `src/sparql`, `src/utils`, `src/expressions`,
  `src/shapes` — type-annotation + method-call migration (typecheck-driven).
- Tests: `core-utils.test.ts` (domain-shape `new`), `sparql-fuseki-shape-sync.test.ts`
  (`new PropertyShape()`), plus any relying on instance methods — migrated. Add a
  throw test.

## Contracts / invariants

- **C1:** `new Person()` (and any Shape subclass, incl. `new NodeShape()`) throws;
  `Person.select/create/update/delete` and all query callbacks behave identically.
- **C2:** `syncShapes()` still serializes shapes (uses static `NodeShape.create` +
  plain-object metadata). Full query + serialization suite stays green.
- **C3:** Metadata objects are plain (`Object.getPrototypeOf === Object.prototype`),
  carry the same fields as today, and are read via free functions.
- **C4:** `NodeShapeData`/`PropertyShapeData` and the free functions are internal;
  the public index surface (README root imports) is unchanged except that `Shape`
  is now non-instantiable.

## Pitfalls

- Keep the tree green at phase boundaries; 2B is the large step (retype + migrate) —
  lean on `tsc` to enumerate every site.
- `PathExpr` values inside `path`/`sortBy` are unchanged (already plain-ish).
- `cached.ts` `instanceof Shape` and `setQueryContext` `instanceof Shape`: metadata
  objects are no longer `instanceof Shape`; ensure their `{id}` branch still covers
  them (it does).
- `parentNodeShape` back-reference on property shapes → keep as a `NodeShapeData`
  reference on the plain object.
- Do not break `shape: NodeShape` / `shape: PropertyShape` *value* usages in decorator
  configs (they reference the class, not the data type) during annotation migration.

## Validation

`npm run typecheck` + `npm test` after each phase; both must stay green
(baseline: typecheck clean, 1478 passed / 117 skipped).

## Phases / Tasks

Strictly ordered — **Phase 2 depends on Phase 1** (all DSL-side instance creation
must be gone before the constructor is guarded, or the guard breaks the DSL). Not
parallelizable.

### Phase 1 — Introduce `createShapeTarget()`; retarget all DSL proxy-target sites
No guard yet; behavior must be identical to today (ghosts are drop-in Shapes).

Tasks:
1. Add `createShapeTarget()` helper (`src/shapes/Shape.ts`).
2. `src/queries/SelectQuery.ts`: `generatePathValue` (`:561`,`:606`), `QueryShape.as`
   (`:1203`), `QueryShapeSet.as` (`:955`) → `createShapeTarget(...)`.
3. `src/queries/ProxiedPathBuilder.ts` (`:27`) → `createShapeTarget(shape)`.
4. `src/queries/QueryContext.ts` (`:136`) → `createShapeTarget(shapeType, value.id)`.
5. `src/shapes/Shape.ts`: `mapPropertyShapes` + `getSetOf` → `createShapeTarget(this)`.

Validation:
- `npm run typecheck` clean.
- `npm test` — 1478 passed / 117 skipped (no regressions), 5 snapshots pass.
- Grep confirms no `new shapeClass()` / `new this()` / `new (shape` / `new (Shape`
  remains in the DSL read/mutation path (`SelectQuery.ts`, `ProxiedPathBuilder.ts`,
  `QueryContext.ts`, `Shape.mapPropertyShapes`/`getSetOf`).

### Phase 2 — Full plain-object meta-model + unconditional throw
Depends on Phase 1. Split into sub-phases, each green at its boundary.

**Phase 2A — Data types + free-function module (additive).**
1. Add `src/shapes/nodeShapeData.ts`: `NodeShapeData` + `PropertyShapeData`
   interfaces; free functions (`getPropertyShapes`, `getUniquePropertyShapes`,
   `getPropertyShape`, `propertyShapeToResult`, `nodeShapeEquals`,
   `addPropertyShape`, `clonePropertyShape`); factories
   (`createNodeShapeData`, `createPropertyShapeData`).
2. Point the existing `NodeShape`/`PropertyShape` instance methods at the free
   functions (delegate) so behavior is proven while the tree stays green.
Validation: typecheck clean; full suite green.

**Phase 2B — Convert construction + retype + migrate call sites.**
1. Factories build plain objects (`Package.ts:310/562`, `SHACL.ts:764`, clone).
2. `Shape.shape` + `ShapeConstructor.shape` → `NodeShapeData`.
3. Migrate all `NodeShape`/`PropertyShape` *type* annotations → `*Data`
   (typecheck-driven, file by file), protecting decorator-config *value* usages.
4. Replace instance-method calls with free-function calls (~22 sites).
5. Strip now-dead instance members/methods from the `NodeShape`/`PropertyShape`
   classes; they remain static-only handles.
Validation: typecheck clean; full suite green (1478 passed).

**Phase 2C — Unconditional throw + cleanup + tests.**
1. `Shape` constructor throws unconditionally; remove `_instantiable` allowlist +
   `Shape.allowInstantiation` calls.
2. Update tests that construct shapes directly; add a test asserting `new Person()`
   throws with the guidance message and the DSL path still works.
Validation: typecheck clean; full suite green incl. the new throw test; grep
confirms no `new NodeShape`/`new PropertyShape`/`new <domainShape>` remains.

### Exit
All sub-phases green → proceed to review.

## Progress log

### Phase 1 — DONE ✅ (commit 9e509e6)
Retargeted all DSL proxy-target `new` sites to `createShapeTarget()` (constructor-
less ghosts). Validation: typecheck clean; `npm test` = 1478 passed / 117 skipped /
5 snapshots (baseline parity).

### Phase 2A + 2B — DONE ✅
Converted `NodeShape`/`PropertyShape` metadata containers to plain
`NodeShapeData`/`PropertyShapeData` objects + free functions:
- New `src/shapes/nodeShapeData.ts` (interfaces, factories, free functions).
- `NodeShape`/`PropertyShape` reduced to static-only DSL handles (never instantiated).
- Construction factories (`applyLinkedShape`, base `Shape.shape`, `createPropertyShape`,
  `clone`) build plain objects.
- `Shape.shape` / `ShapeConstructor.shape` retyped to `NodeShapeData`.
- ~178 type annotations migrated to `*Data`; ~30 instance-method call sites (prod +
  tests) rewritten to free functions (`getPropertyShapes`, `getUniquePropertyShapes`,
  `getPropertyShape`, `propertyShapeToResult`, `nodeShapeEquals`, `addPropertyShape`,
  `createPropertyShapeData`).
- The abandoned R2 allowlist was removed; the constructor is permissive again
  (unconditional throw lands in 2C).
Validation: typecheck clean; `npm test` = 1478 passed / 117 skipped / 5 snapshots
(full baseline parity — behavior-preserving).

### Phase 2C — DONE ✅
- `Shape` constructor now throws unconditionally (no args, no allowlist) with a
  DSL-steering message.
- Discovered `SparqlDataset` (parent of `FusekiStore`) extended `Shape` purely for an
  aspirational-unused "persist dataset config as linked data" reason and is genuinely
  instantiated as a live store — it uses no Shape members. Removed `extends Shape`
  (a dataset is not a metadata shape). This unblocked the fuseki suites.
- Updated `core-utils.test.ts` (2 sites) to build proxy targets via
  `createShapeTarget()` instead of `new`.
- Added `src/tests/shape-instantiation-guard.test.ts`: `new Person()` / `new Shape()`
  throw; the DSL still builds queries/mutations without instantiating; metadata is a
  plain object (`Object.getPrototypeOf(shape) === Object.prototype`).
Validation: typecheck clean; `npm test` = 1481 passed / 117 skipped / 5 snapshots
(1478 baseline + 3 guard tests).

## Outcome
No Shape subclass is instantiated anywhere: SHACL metadata is plain
`NodeShapeData`/`PropertyShapeData` objects, the DSL builds constructor-less proxy
targets via `createShapeTarget()`, and `new SomeShape()` throws a clear
DSL-steering error. All three phases green.

## Review

Commits: `9e509e6` (Phase 1), `89890d5` (Phase 2A+2B), `7f2318f` (Phase 2C),
plus a no-op-cast cleanup. Final state: typecheck clean; 1481 passed / 117 skipped /
5 snapshots; `git grep` confirms no `new <Shape subclass>()` remains in production.

Verified invariants (C1–C4): `new Person()`/`new Shape()` throw (guard test); the DSL
builds queries/mutations without instantiating; metadata objects are plain
(`Object.getPrototypeOf === Object.prototype`); `NodeShapeData`/`createShapeTarget`
are not exported from the public index.

Gaps / notes for the user to weigh (candidate `iterate` items):
1. **Behavior change — dropped diagnostic.** `nodeShapeData.getPropertyShapes` no
   longer emits the one-time `console.warn` for a superclass whose `propertyShapes`
   is missing/invalid (the old `listPropertyShapesSafe` warning, for duplicate-install
   scenarios). Functionally it still treats such shapes as `[]`. Re-add the warning if
   that diagnostic is valued.
2. **`SparqlDataset` no longer `extends Shape`.** Removed because it was unused and
   made every store construction hit the guard. If "persist a dataset config as linked
   data" is a real future need, model the *config* as its own metadata shape rather
   than making the live store a Shape.
3. **`getSetOf` / `mapPropertyShapes`** now return constructor-less ghosts
   (`createShapeTarget`) rather than `new this()`. They appear unused internally;
   consider deleting them in wrapup if no consumer relies on them.
4. **`propertyShapeToResult` / `PropertyShapeResult`** now have only test callers (the
   `NodeShape.properties` getter and `getResult()` were removed). Kept for the SHACL
   introspection projection; could be pruned if unused downstream.
5. **Follow-up polish (wrapup):** the `createShapeTarget` docstring, and the residual
   `NodeShapeData` type-only import in `MutationQuery.ts` if it became unused.
