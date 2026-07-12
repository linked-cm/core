---
title: Disallow Shape instances — DSL uses proxies + guarded constructor
status: Implementation
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

## Route decision (revised during planning)

Two routes were on the table:

- **R1 — Plain-object meta-model + unconditional throw.** Convert
  `NodeShape`/`PropertyShape` to plain objects + free functions, then throw
  unconditionally in the constructor.
- **R2 — Guarded constructor (SELECTED).** Remove the DSL's own instance usage
  (`ShapeRef`), then guard the constructor with an internal token so only the
  framework meta-shapes may instantiate; domain `new Person()` throws.

**Why R2:** Planning measurement showed R1 touches **~291 `NodeShape`/`PropertyShape`
type annotations across 29 files** and fights a structural-typing constraint
(`NodeShape extends Shape` is required so `NodeShape.create()` works, which forces
the instance type to carry Shape's `uri`/`nodeShape` getters, so plain-object
literals are not cleanly assignable). Per the priority framework (maintainability →
scalability → performance), R1's churn/risk **inverts** the simplicity it was meant
to buy — the unconditional throw's only benefit over a token was "no token." R2
achieves the identical consumer-facing guarantee with a small, well-bounded diff.
R1 is recorded as a deferred follow-up (see Deferred section) for the user to
iterate on if desired.

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
- **D2 — Token-guarded constructor.** A module-private `SHAPE_INIT_TOKEN` symbol.
  `Shape`'s constructor throws unless it receives the token. Framework meta-shape
  constructors (`NodeShape`, `PropertyShape`) pass it via `super(SHAPE_INIT_TOKEN, …)`.
- **D3 — Collapse the 3 `instanceof Shape` sites.** After D1 no domain value is ever
  a Shape instance, so: `getSetOf` builds a `ShapeRef`-based `ShapeSet`;
  `setQueryContext` and `cached` drop the dead instance branch.
- **D4 — Keep `NodeShape`/`PropertyShape` classes unchanged** (still instantiable
  internally via the token). No plain-object conversion in this cycle.

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

### Constructor guard (src/shapes/Shape.ts + SHACL.ts)
- `Shape` constructor: `constructor(token?: unknown, node?: string | NodeReferenceValue)`
  → throw unless `token === SHAPE_INIT_TOKEN`.
- `NodeShape`/`PropertyShape` constructors call `super(SHAPE_INIT_TOKEN, node)`.
- Error message: ``Cannot instantiate shape `${new.target.name}` directly. Shapes
  are metadata only — use the DSL (`${name}.select(...)`, `.create(...)`,
  `.update(...)`, `.delete(...)`).``

## Expected file changes

- `src/shapes/Shape.ts` — ShapeRef type/factory, guarded constructor, SHAPE_INIT_TOKEN,
  `mapPropertyShapes`/`getSetOf` retarget.
- `src/shapes/SHACL.ts` — `NodeShape`/`PropertyShape` constructors pass the token.
- `src/queries/SelectQuery.ts` — `QueryShape`/`QueryShapeSet` originalValue → ShapeRef;
  `generatePathValue`, `.as()`, `proxifyQueryShape`, `get id`.
- `src/queries/ProxiedPathBuilder.ts` — ref instead of `new shape()`.
- `src/queries/QueryContext.ts` — ref materialization; drop instance branch.
- `src/utils/cached.ts` — drop dead `instanceof Shape` branch.
- Tests that do `new SomeShape()` on domain shapes (`core-utils.test.ts:129,270`)
  and `new PropertyShape()` (`sparql-fuseki-shape-sync.test.ts:134`) — updated.

## Contracts / invariants

- **C1:** `new Person()` (any domain shape) throws; `Person.select/create/update/delete`
  and all query callbacks behave identically to today.
- **C2:** `syncShapes()` still serializes shapes (framework meta-shapes still
  instantiate via the token). Full query + serialization suite stays green.
- **C3:** Query-context refs (`{@ctx}`), `.for()`, `.as()`, where/sort/minus all
  behave identically (ShapeRef carries `id` + context stamps).
- **C4:** `ShapeRef` is internal; not exported from the package index.

## Pitfalls

- `QueryShape.as()` and `QueryShapeSet.as()` copy `.id` onto a fresh instance today —
  must copy onto the fresh `ShapeRef`.
- The generic `new Shape()` node-reference projection (`SelectQuery.ts:606`) must
  become a `ShapeRef` whose `shapeClass` is the base `Shape` (still valid: reads
  only `.shape`/`.id`).
- Passthrough keys (`INTEROP_PASSTHROUGH_KEYS`) in `proxifyQueryShape` currently
  return `originalShape[key]` — on a ref, symbol/interop keys should return
  `undefined`/ref field, not throw.
- Implicit subclass constructors forward args to `super`; `new Person('id')` passes
  `'id'` as the token slot → throws (correct).

## Deferred (candidate for review-time iterate)

- **R1 — plain-object meta-model:** convert `NodeShape`/`PropertyShape` to
  `NodeShapeData`/`PropertyShapeData` plain objects + a `nodeShapeData.ts`
  free-function module (`getPropertyShapes`, `getUniquePropertyShapes`,
  `getPropertyShape`, `propertyShapeToResult`, `nodeShapeEquals`, `addPropertyShape`,
  `clonePropertyShape`), then drop the token for an unconditional throw. ~291 type
  sites; do as its own focused effort with the test suite as the safety net.

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

### Phase 2 — Token-guarded constructor
Depends on Phase 1.

Tasks:
1. `src/shapes/Shape.ts`: module-private `SHAPE_INIT_TOKEN`; constructor
   `(token?, node?)` throws with the DSL-steering message unless `token` matches.
2. `src/shapes/SHACL.ts`: `NodeShape` + `PropertyShape` constructors call
   `super(SHAPE_INIT_TOKEN, node)` (import the token).
3. Update tests that instantiate shapes directly: `core-utils.test.ts` (domain
   shapes) and `sparql-fuseki-shape-sync.test.ts` (`new PropertyShape()`).
4. Add a test asserting `new Person()` (a domain shape) throws with the guidance
   message, and that the DSL path still works.

Validation:
- `npm run typecheck` clean.
- `npm test` — full suite green including the new guard test.
- Grep confirms the only Shape-subclass `new` sites are the framework meta-shape
  factories passing `SHAPE_INIT_TOKEN`.

### Exit
Both phases green → proceed to review.

## Progress log

### Phase 1 — DONE ✅
Retargeted all DSL proxy-target `new` sites to `createShapeTarget()` (constructor-
less ghosts): `Shape.mapPropertyShapes`/`getSetOf`, `ProxiedPathBuilder`,
`SelectQuery.generatePathValue` (×2) + `QueryShape.as`/`QueryShapeSet.as`,
`QueryContext` `{id}` materialization. Validation: `npm run typecheck` clean;
`npm test` = 1478 passed / 117 skipped / 5 snapshots (baseline parity, no
regressions). Grep confirms no proxy-target `new` sites remain in the DSL path.
