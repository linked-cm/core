---
summary: Shapes are now metadata-only. `Shape` subclasses can no longer be instantiated (the constructor throws), SHACL metadata is exposed as plain `NodeShapeData`/`PropertyShapeData` objects with former instance methods extracted as free functions, and the query DSL builds constructor-less proxy targets via `createShapeTarget()`.
---

# Disallow Shape instances — plain-object SHACL metadata

## Outcome

No `Shape` subclass is instantiated anywhere in the codebase:

- `new SomeShape()` (and `new Shape()`) throws a clear error steering consumers to
  the DSL. Shapes carry no live data — their decorated getters only return typing
  stubs — so direct instantiation was always a footgun; it is now a loud error.
- SHACL metadata (`SomeShape.shape` and every property shape) is a plain object
  (`NodeShapeData` / `PropertyShapeData`), i.e. the QResult-like data you would get
  from selecting all properties of the meta-shape. The former `NodeShape` /
  `PropertyShape` instance methods are now free functions.
- The query DSL builds throwaway proxy targets with `createShapeTarget()`
  (`Object.create`, constructor-less) instead of `new`, so the throwing constructor
  never blocks query/mutation building.

## Background

The DSL was already class-and-proxy based: builders store only the shape *class*
(`ShapeConstructor`), metadata lived statically on `SomeShape.shape`, and query
results were plain objects. The only remaining Shape instances were vestigial:
"dummy" proxy targets whose accessor logic was never invoked (the query proxy
intercepts every property access), plus the SHACL meta-model containers
(`NodeShape`/`PropertyShape`). This change removes both.

## Architecture

### Proxy targets — `createShapeTarget()` (`src/shapes/Shape.ts`)

```ts
export function createShapeTarget<S extends Shape>(
  shapeClass: ShapeConstructor<S> | typeof Shape, id?: string,
): S {
  const target = Object.create(shapeClass.prototype) as S;
  if (id !== undefined) target.id = id;
  return target;
}
```

A constructor-less, prototype-linked `Shape` used only as a proxy / metadata-carrier
target. It is a genuine `Shape` on the prototype chain (so `.constructor`, the
`nodeShape` getter, `ShapeSet`, and `getLeastSpecificShape` keep working) but never
runs the (throwing) constructor. Internal only — not exported from the package index.

Every prior `new ShapeSubclass()` proxy site routes through it:
`Shape.mapPropertyShapes`/`getSetOf`, `ProxiedPathBuilder.createProxiedPathBuilder`,
`SelectQuery.generatePathValue` (single + generic-base branches),
`QueryShape.as`/`QueryShapeSet.as`, and `QueryContext.setQueryContext`'s `{id}`
materialization.

### Plain-object metadata (`src/shapes/nodeShapeData.ts`, NEW)

- Interfaces `NodeShapeData` and `PropertyShapeData` (standalone, NOT `extends Shape`,
  so plain object literals are assignable) carrying the same fields the classes did.
- Factories `createNodeShapeData(id)` and `createPropertyShapeData()`.
- Free functions replacing the former instance methods:
  - `getPropertyShapes(nodeShape, includeSuperClasses?)` — walks the registered
    shape-class inheritance chain via `getShapeClass(nodeShape.id)`.
  - `getUniquePropertyShapes(nodeShape)` — deduped by label across the chain.
  - `getPropertyShape(nodeShape, label, checkSubShapes?)`.
  - `addPropertyShape(nodeShape, propertyShape)`, `clonePropertyShape(ps)`,
    `nodeShapeEquals(a, b)`.
  - `ownPropertyShapes` (internal) preserves the once-per-shape `console.warn`
    diagnostic for a missing/invalid `propertyShapes` array (duplicate-install case).
- `@deprecated` (scheduled for removal): `propertyShapeToResult` + `PropertyShapeResult`
  (the SHACL result projection — no production callers remain).

`NodeShape` / `PropertyShape` (`src/shapes/SHACL.ts`) are reduced to **static-only DSL
handles**: `class X extends Shape { static targetClass = … }`. They keep their static
`.shape` self-description and the inherited static DSL methods (`NodeShape.create`,
`.select`, `DeleteBuilder.from(NodeShape)`) that `syncShapes` uses to write the SHACL
model into a store. They are never instantiated. `PropertyShapeResult` and the free
functions are re-exported from `SHACL.ts` for existing import paths.

### Metadata construction

Three factory sites build plain objects instead of `new`:
- `applyLinkedShape` (`Package.ts`) mints each shape's `.shape` via `createNodeShapeData`.
- Base `Shape.shape` bootstrap (`Package.ts`) via `createNodeShapeData`.
- `createPropertyShape` (`SHACL.ts`) via `createPropertyShapeData`; the former
  `PropertyShape.clone()` is now `clonePropertyShape` (a spread).

`Shape.shape` and `ShapeConstructor.shape` are typed `NodeShapeData`. `~178` type
annotations across ~26 files migrated `NodeShape`/`PropertyShape` → `*Data`, and
`~30` instance-method call sites (production + tests) were rewritten to free-function
calls.

### The constructor guard (`src/shapes/Shape.ts`)

```ts
constructor() {
  const name = (new.target as {name?: string} | undefined)?.name || 'Shape';
  throw new Error(
    `Cannot instantiate shape \`${name}\` directly — shapes are metadata, not data. ` +
      `Use the DSL instead: ${name}.select(...), .create(...), .update(...), or .delete(...).`,
  );
}
```

Unconditional — no allowlist or token — because nothing constructs a Shape anymore.
`ShapeConstructor`'s concrete-`new` type is documented as a type-level capability only.

### `SparqlDataset` is no longer a `Shape`

`SparqlDataset` (parent of `FusekiStore`) is a live store that is genuinely
instantiated. It extended `Shape` only for an aspirational, unused "persist dataset
config as linked data" rationale and referenced no `Shape` member, so once the
constructor threw, every store construction broke. It now `implements IDataset`
directly. A dataset-config *metadata shape* can be introduced separately if that
capability is ever wanted.

## Public API surface

New/changed exports from `@_linked/core` (via `SHACL.ts` re-exports):
- Types: `NodeShapeData`, `PropertyShapeData` (metadata); `PropertyShapeResult`
  (deprecated).
- Functions: `getPropertyShapes`, `getUniquePropertyShapes`, `getPropertyShape`,
  `addPropertyShape`, `clonePropertyShape`, `nodeShapeEquals`, `createNodeShapeData`,
  `createPropertyShapeData`, `propertyShapeToResult` (deprecated).
- `createShapeTarget` is exported from `Shape.ts` for internal/test use but NOT from
  the package index.

Migration for consumers who read metadata via the old instance methods:
`Person.shape.getUniquePropertyShapes()` → `getUniquePropertyShapes(Person.shape)`.
Consumers who only use the query DSL need no change.

## Key design decisions

- **Constructor-less ghosts for proxy targets** (`Object.create`) rather than a plain
  `ShapeRef` object: a `ShapeRef` would have rippled invasively through
  `ShapeSet<S extends Shape>`, `QueryShapeSet`, and `getLeastSpecificShapeClasses`,
  which rely on proxy-target members being real `Shape`s exposing `.nodeShape`. The
  ghost is a drop-in and keeps those internals untouched.
- **Full plain-object conversion over a guard-only approach.** A `new.target`
  allowlist (exempting the meta-shapes) was prototyped and rejected in favor of
  converting the meta-model to plain objects — this lets the constructor throw
  unconditionally with no special-case, and models metadata as the data it is.
- **`NodeShape`/`PropertyShape` kept as static-only classes** rather than deleted:
  `syncShapes` writes the SHACL model to a store via their static DSL methods, and
  they carry the meta-model self-description. Only their instance side was removed.
- **Standalone `*Data` interfaces** (not `extends Shape`): required so plain object
  literals are assignable, since `Shape`'s instance type carries `uri`/`nodeShape`
  getters.

## Test coverage

`npm test` = **1481 passed / 117 skipped / 5 snapshots**; `npm run typecheck` clean.

- `src/tests/shape-instantiation-guard.test.ts` (NEW): `new Person()` / `new Shape()`
  throw with the DSL-steering message; the DSL still builds queries/mutations without
  instantiating; metadata is a plain object (`Object.getPrototypeOf(shape) ===
  Object.prototype`).
- Existing SHACL/metadata suites (`metadata`, `shacl-metamodel`, `shacl-constraints`,
  `shacl-constraint-serialization`, `shacl-list-pathnode`, `shacl-serialization-flags`,
  `gap1-fixes`, `sparql-fuseki-shape-sync`) migrated to the free-function API; the
  constraint tests now assert plain `PropertyShapeData` fields directly rather than
  the deprecated `propertyShapeToResult` projection.
- `core-utils` builds proxy targets via `createShapeTarget()` instead of `new`.
- Full query/mutation/IR/SPARQL/DSL-JSON suites pass unchanged, confirming behavior
  parity.

## Known limitations / follow-ups

- Deprecated APIs (`Shape.getSetOf`, `Shape.mapPropertyShapes`, `propertyShapeToResult`,
  `PropertyShapeResult`) are retained with `@deprecated` and have no callers; delete in
  a follow-up.
- A dataset-config metadata shape (the dropped `SparqlDataset extends Shape` rationale)
  is not implemented; add as a dedicated shape if the need arises.

## Documentation

- README override-behavior note updated to the free-function form.
- Changeset: `.changeset/shape-metadata-plain-objects.md` (minor) documents the
  behavioral change and the new/deprecated exports.
