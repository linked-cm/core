---
'@_linked/core': minor
---

One shape metamodel, and inheritance that works for shapes known only as data.

`NodeShapeData` gains a JSON-safe transport form (`toWire` / `fromWire` in
`shapes/nodeShapeWire.ts`). It is defined by subtraction from the metamodel — drop the
circular `parentNodeShape` back-reference, carry `pattern` as its source string and flags
— so new metamodel fields are carried automatically instead of a hand-maintained subset
falling behind. `PathExpr` is already a plain discriminated union, so complex SHACL paths
(sequence, alternative, inverse, the cardinality operators, negated property sets) survive
a round trip intact rather than collapsing to a single IRI.

Display vocabulary: `linked_core:displayRank` (a single linear importance rank, lower =
more important) and `linked_core:displayHidden`, accepted by the property decorators,
carried on `PropertyShapeData`, registered as meta-shape properties and serialized by
`syncShapes`. They materialize onto the pure `sh:NodeShape`, so they travel with an
ejected app.

Fixes `order` and `group`, which were declared on `PropertyShapeConfig` but never copied
onto the property shape — a declared `sh:order` was silently dropped and renderers fell
back to array position.

`getSuperShapes` is now the single canonical inheritance walk, and `getPropertyShapes`,
`getPropertyShape` and the class-returning helpers all delegate to it: the prototype chain
for a class-backed shape (which includes the framework `Shape` root, whose `label` and
`type` really are inherited), `extends` through the shape registry for a shape with no
compiled class. Previously the latter case returned only own properties, so a
project-authored shape silently lost everything it inherited (backlog 040). Since
`getPropertyShapeByLabel` delegates to `getPropertyShape`, the query proxies are fixed
too.

Adds a primary IRI to `NodeShapeData` registry alongside the class registry, so query
lowering and predicate resolution work for both kinds of shape;
`registerNodeShape` / `getNodeShape` / `getAllNodeShapes` and the data-based
`getSuperShapes` / `getSubShapes` / `isSubShapeOf` are exported.
`SelectBuilder.from(iri)` now resolves a shape that exists only as data.

Cache invalidation moves from a `setTimeout` plus registry-size comparison to a monotonic
version counter — the old scheme silently reused a stale cache when a registration and a
removal coincided, or when a shape was re-registered in place.

Adds `registerRuntimeShape` / `registerRuntimeShapes`: register a shape that exists only
as data, taking metadata (`NodeShapeData` or its wire form) rather than a bespoke DTO.
`registerRuntimeShapes` orders a batch parents-first, because inheritance resolves
`extends` through the registry and a child registered ahead of its parent would resolve an
empty chain. Neither shadows a compiled class.

Query lowering, containment resolution, blank-node deletion and mutation lowering all read
the shape registry rather than the class registry, so a shape that exists only as data
lowers to the same SPARQL a compiled one does — with its declared `targetClass` (walking
`extends` where it is inherited) and its declared `sh:path` as the predicate. `validate()`
accepts such a shape as registered. The three lowering caches key on the registration
version instead of the class registry's size, which did not change when a shape was
re-registered in place.

The SHACL meta-model's `sh:equals` accessor is relabelled `equalsConstraint`, matching the
`PropertyShapeData` field (the predicate is unchanged). `equals` is a query-builder method,
and the query proxy answers a key from its own surface before it looks for a property with
that label — so a property labelled `equals` returned the DSL method and the field tracer
failed on a native function. The meta-shape could not read its own constraint. Anything
looking a constraint up in `getPropertyShapeTerms()` by the label `equals` must now ask for
`equalsConstraint`.

Registration now reports the general case: `registerPropertyShape` and
`registerRuntimeShape` check each label against the query DSL surface
(`RESERVED_QUERY_DSL_NAMES`) and warn once per shape+label, naming the shape, the property
and why selecting it will fail. It warns rather than throws — `size`, `id` and `some` are
legitimate domain property names, such a property still round-trips and is still reachable
by path through DSL-JSON, and throwing would break existing apps on upgrade.

