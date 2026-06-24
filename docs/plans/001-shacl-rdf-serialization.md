---
summary: Serialize registered NodeShapes to the store as SHACL via the query engine — reuse the Package.ts meta-model, add a containment cascade (contains + dependent), List/PathNode shapes, and syncShapes() upsert. Supersedes ideation in ideas/015.
status: Ideation
source: ideas/015-shacl-rdf-serialization.md
related: ideas/013-shacl-property-paths.md, ideas/005-named-graph-support.md, reports/011-shacl-property-paths-and-prefix-resolution.md
scope: packages/core only (no CN changes; CN consumes syncShapes() later)
---

# SHACL Shape Serialization & Sync — Active Plan

Active working doc for `ideas/015`. One doc from ideation → review. **All work in `@_linked/core`.**

## Problem & direction

NodeShape/PropertyShape carry rich SHACL metadata that is never persisted. We want shapes
defined in code written to the store as SHACL data so they're queryable and loadable into
validation triplestores. **Code is canonical; the store is a rebuildable projection.**

- **Output = queries, not an RDF artifact.** `syncShapes()` returns built-but-unexecuted
  queries; awaiting them updates the store.
- **Dogfood the engine** — serialize shapes by `create`-ing instances of the existing meta-model
  (NodeShape/PropertyShape), not a parallel triple emitter.
- **Full scope:** complex `sh:path` (sequence/inverse/alt/cardinality) and `sh:in` are supported,
  which requires proper ordered `rdf:List` writing and clean re-sync deletion of those structures.

## Accepted decisions (ideation)

- **D1 — Re-sync = delete + recreate per shape.** Per in-code shape: `delete`-by-id (no-op if
  absent; cascades, see D7) then `create`. Identity-read the store only for **orphan detection**
  (shapes/property-shapes present in store but not in code → delete). No field-level diffing
  (`update` would leave stale removed-constraint triples; recreate handles removals for free).
- **D2 — Default graph.** Named-graph writes aren't implemented (idea 005); isolation deferred.
- **D3 — `syncShapes()` returns thunks.** Async; identity-reads via the global query dispatch;
  returns `Array<() => Promise<void>>` — one thunk per shape running `delete → create` in order,
  plus orphan-delete thunks. Caller: `await Promise.all(plan.map(run => run()))` (per-shape order
  guaranteed; shapes parallelize). Optional injected executor for tests.
- **D4 — Exclude framework shapes** from sync via `constructor.packageName === '@_linked/core'`
  (drops NodeShape/PropertyShape/List/PathNode/Shape themselves).
- **D5 — Reuse the existing meta-model in `Package.ts`.** NodeShape/PropertyShape already have
  property shapes applied there (externally, due to circular deps). **Extend** that meta-model with
  the missing accessors (`minCount`, `maxCount`, `datatype`, `nodeKind`, `class`, `in`, `equals`,
  `disjoint`, `hasValue`, `order`, `group`, `name`, `lessThan`, `lessThanOrEquals`, `node`/valueShape,
  `closed`, `ignoredProperties`). **No new `SHACLNodeShape` classes.** Serialize via
  `NodeShape.create({...}).withId(shapeIri)`.
- **D6 — Writes reuse nested-create; no new mutation primitive.** `rdf:List`/path structures are
  written as nested node-data chains via the existing recursive `create` lowering
  (`generateNodeDataTriples`). The earlier "rdfList engine primitive" (old todo #4) is **dropped.**
- **D7 — Containment cascade = `contains` (edge) + `dependent` (node), Plan A.** New declarative flags:
  - `linked:contains` on a property → the cascade *follows* this edge (and it doubles as composition
    semantics; persisted as a triple on the property shape).
  - `dependent` characteristic on a shape → instances may be deleted when reached through a
    `contains` edge (persisted as a triple on the shape; name TBD: `dependent` /
    `removableWhenOwned` / `ownedLifecycle`).
  - **Discriminator** — a reached node is deleted iff it is **blank OR carries a `dependent`-flagged
    type** (and never `rdf:nil` / shared predicate IRIs, which are neither). The `dependent` set is
    computed from the registry, not hardcoded. Single cascade query: a `contains` property-path
    alternation with `rdf:rest*` for the self-referential list spine.
  - Wire the cascade into **both** `delete`-by-id and `update` old-value removal (one shared helper).
  - *Why Plan A over `dependent`-only:* polymorphic `sh:path` needs an explicit "follow" marker
    regardless, `contains` yields one efficient property-path query, and `contains` is reusable as
    composition semantics. *Orphan-GC kept as documented fallback for shared dependents.*
- **D8 — `List` and `PathNode`.**
  - `List` (existing, `targetClass rdf:List`): rewrite to pure shape — `first` (object property,
    **not** contains) + `rest` (object property, `valueShape: List`, **contains**); drop the in-memory
    `items`/`fromItems`/`getContents`. `dependent: true`. Covers `sh:in` and sequence paths.
  - `PathNode` (**new**, `targetClass linked:PathNode`, `dependent: true`): operator node for
    inverse/alt/cardinality paths, with **contains** accessors `sh:inversePath`, `sh:alternativePath`
    (→ `List`), `sh:zeroOrMorePath`, `sh:oneOrMorePath`, `sh:zeroOrOnePath`. Built recursively.
- **D9 — `sh:path` is polymorphic → dedicated write-translator, untouched `valueShape`.**
  `valueShape` is single-valued and the factory enforces it (MutationQuery.ts:233). So we **do not**
  give `path` a polymorphic valueShape and **leave the existing `path` accessor unchanged.** A
  dedicated routine (adapting `serializePathToSHACL`) emits the `sh:path` field value: simple →
  `{id: predicateIRI}`; sequence → `List` node-data; inverse/alt/cardinality → `PathNode` node-data.
  `sh:in` is monomorphic → `in` accessor gets `valueShape: List`. **This translator is the *only*
  per-type code; deletion of the result is generic via D7.**
- **D10 — Ontology terms** added to `linked-core.ts`: `contains`, plus the `dependent` characteristic
  term; new `PathNode` class IRI. Missing SHACL predicates added to `shacl.ts`: `sh:equals`,
  `sh:disjoint`, `sh:hasValue`, `sh:order`, `sh:group`, `sh:closed`, `sh:ignoredProperties`.

## Generality note

`contains + dependent` cleans **any owned value that is a shape instance** (incl. polymorphic — omit
`valueShape`, supply per-value `shape`, mark each `dependent`). Only **non-shape plain-data** (like
`PathExpr`) needs a write-translator (D9) to emit typed/blank nodes; deletion stays generic. The
blank-or-dependent discriminator future-proofs non-shape structures (emit as blanks → cleaned with
no synthetic shape).

## Implementation outline (todos)

1. Ontology: add missing `shacl.ts` predicates + `linked-core.ts` `contains`/`dependent`/`PathNode`.
2. Decorator/shape support: `contains` on object-property config; `dependent` on shape config; store
   both on PropertyShape/NodeShape; persist as triples in the meta-model.
3. Rewrite `List` (pure shape, `rest` contains) + add `PathNode` shape.
4. Containment cascade: shared helper (`contains` traversal + blank/`dependent` discriminator +
   `rdf:rest*`, exclude `rdf:nil`); wire into `delete`-by-id and `update` old-value removal.
5. Extend the `Package.ts` meta-model with the missing NodeShape/PropertyShape accessors (+ contains
   flags on `properties`, `path`, `in`).
6. Path write-translator (`PathExpr` → `{id}` / `List` / `PathNode` node-data), reusing
   `serializePathToSHACL` structure.
7. `syncShapes()`: enumerate registered shapes (exclude `@_linked/core`), identity-read for orphans,
   return delete→create thunks + orphan-delete thunks.
8. Tests (jest, golden-SPARQL via `captureQuery` + `createToSparql`): nested-list create, complex
   paths, `sh:in`, cascade delete (lists/paths/property-shapes; nil & predicate-IRI safety), sync
   upsert/orphan-delete.
9. `yarn linked build` + run suite; fix.

## Verification items for plan/impl (not user decisions)

- **Main risk:** `rdf:rest*` (and the `contains` property-path alternation) usable in **DELETE WHERE**
  (algebra has `{kind:'path'}` terms; prove the delete path). Pick cascade SPARQL shape in plan.
- `update` cascade wiring shares the delete helper; confirm `updateToAlgebra` integration.
- `getAllShapeClasses()` populated at sync time (decorators run / bundling).
- Confirmed: `update` replaces predicate values one-hop; `delete`-by-id cascades blank subtrees
  (`walkBlankNodeTree`); `Shape.select`/`selectAll` read path exists; factory enforces single
  `valueShape` (MutationQuery.ts:233).

## Backlog candidates (propose, not actioned)

- Review/migrate `editInline` (likely replaced by `contains` / a shape/view config).
- General first-class `rdfList()` DSL primitive for user ergonomics (`{tags: rdfList([...])}`).
- `update`-side cascade as a standalone general feature beyond sync's needs.
