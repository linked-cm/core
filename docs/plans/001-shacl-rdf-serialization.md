---
summary: Serialize registered NodeShapes to the store as SHACL via the query engine — reuse the Package.ts meta-model, add a containment cascade (contains + dependent), List/PathNode shapes, and syncShapes() upsert. Supersedes ideation in ideas/015.
status: Implementation
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
- **D6 — Writes reuse nested-create; public `rdfList()` helper (no engine primitive).** `rdf:List`
  and path structures are written as nested `List` node-data chains via the existing recursive
  `create` lowering (`generateNodeDataTriples`) — no new IR/mutation-engine variant. We expose a
  **public `rdfList()` DSL helper** (in scope) that builds that chain, so users can write ordered
  collections (`Playlist.create({ tracks: rdfList([t1,t2,t3]) })`) instead of unordered sets. The
  SHACL `in` serializer uses the same helper. (The heavier `{__rdfList}` IR primitive remains dropped.)
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
3. Rewrite `List` (pure shape, `rest` contains) + add `PathNode` shape + public `rdfList()` helper.
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

## Files expected to change

| File | Change |
|---|---|
| `src/ontologies/shacl.ts` | add `sh:equals`, `sh:disjoint`, `sh:hasValue`, `sh:order`, `sh:group`, `sh:closed`, `sh:ignoredProperties` |
| `src/ontologies/linked-core.ts` | add `contains`, the `dependent` term, and `PathNode` class IRI |
| `src/shapes/SHACL.ts` | `PropertyShape.contains?: boolean`; `NodeShape.dependent?: boolean`; `contains` on `ObjectPropertyShapeConfig`; `dependent` on shape config; `createPropertyShape` sets `contains` |
| `src/shapes/List.ts` | rewrite to pure shape (`first` not-contains, `rest` contains+self valueShape, `dependent`); drop `items`/old helpers; add public `rdfList()` helper (D6) |
| `src/shapes/PathNode.ts` (new) | operator-node meta-shape (`dependent`, `contains` path-operator accessors) |
| `src/shapes/serializePathToNodeData.ts` (new) | `PathExpr → {id} \| List \| PathNode` node-data translator (reuses `serializePathToSHACL` structure) |
| `src/shapes/syncShapes.ts` (new) | enumerate → identity-read → return delete→create + orphan-delete thunks |
| `src/utils/Package.ts` | read `dependent` in `applyLinkedShape` (set + persist on NodeShape); extend meta-model accessors; mark `properties`/`path`/`in` as `contains`; register `List`/`PathNode` |
| `src/sparql/irToAlgebra.ts` | shared **owned-cascade** helper; wire into `deleteToAlgebra` and the `update` old-value removal |
| `src/index.ts` | export `syncShapes`, `List`, `PathNode`, `rdfList` |
| `src/tests/*.test.ts` | unit tests (below) |
| `src/tests/sparql-fuseki-shape-sync.test.ts` (new) | e2e (matches existing `sparql-fuseki` pattern) |

## Inter-component contracts (signatures)

```ts
// SHACL.ts — config + stored flags
interface ObjectPropertyShapeConfig { /* … */ contains?: boolean }
interface ShapeConfig             { /* … */ dependent?: boolean }   // used by linkedShape()
class PropertyShape { /* … */ contains?: boolean }
class NodeShape     { /* … */ dependent?: boolean }

// List.ts — public ordered-list helper (D6). Builds the nested List node-data chain.
//  base set → deterministic cell ids ({base}/0,1,…); omitted → engine-minted ids.
function rdfList<T>(items: T[], opts?: { base?: string }): NodeDescriptionValue;

// serializePathToNodeData.ts — the only per-type write-translator (D9)
//  simple → {id}; sequence → List node-data; inverse/alt/cardinality → PathNode node-data
function serializePathToNodeData(
  path: PathExpr, baseIri: string,
): NodeReferenceValue | NodeDescriptionValue;

// irToAlgebra.ts — shared owned-cascade (used by delete AND update)
//  follows `contains` edges from rootVar; deletes reached nodes that are blank OR
//  carry a `dependent`-flagged type; excludes rdf:nil; rdf:rest* for the list spine.
function buildOwnedCascade(
  rootVar: string, shapeId: string,
): { deletePatterns: SparqlTriple[]; whereOptional: SparqlAlgebraNode | null };

// syncShapes.ts — returns built-but-unexecuted, order-correct thunks (D3)
function syncShapes(
  options?: { dataset?: IDataset },   // defaults to global query dispatch
): Promise<Array<() => Promise<void>>>;
// caller: await Promise.all((await syncShapes()).map(run => run()))
```

## Small examples

```ts
// Serializing one shape (D5/D6): build via the existing meta-model, deterministic id.
NodeShape.create({
  targetClass: {id: targetClassIri},
  description, closed,
  properties: propertyShapes.map(ps => ({
    __id: `${shapeIri}/${ps.label}`,
    path: serializePathToNodeData(ps.path, `${shapeIri}/${ps.label}`),
    minCount: ps.minCount, datatype: ps.datatype, /* … */ name: ps.name,
    in: ps.in ? listNodeData(ps.in, `${shapeIri}/${ps.label}/in`) : undefined,
    contains: ps.contains,
  })),
}).withId(shapeIri);

// rdf:List as nested List node-data (D6) — no engine primitive needed.
function listNodeData(items, base) {
  return items.reduceRight((rest, item, i) =>
    ({ shape: List, __id: `${base}/${i}`, first: item, rest }), {id: rdf.nil.id});
}
```

## Potential pitfalls

- **`rdf:rest*` in DELETE WHERE** (main risk) — algebra has `{kind:'path'}` terms; prove the
  delete path supports it before relying on it. Fallback: bounded structural levels + a small loop.
- **Don't break the `path` query accessor** — leave its single `valueShape` intact; path
  polymorphism lives only in the translator (D9).
- **Circular deps** — `List`/`PathNode` + new meta-model accessors must be set up in `Package.ts`
  *after* `NodeShape`/`PropertyShape` (the existing pattern), not via inline decorators.
- **Registry timing** — `getAllShapeClasses()` only has shapes whose modules were imported; tests
  must import the shape package before `syncShapes()`.
- **Cascade safety** — must exclude `rdf:nil` and never delete shared enum IRIs / predicate IRIs
  (the blank-or-`dependent` discriminator handles this; assert it explicitly in tests).
- **Ordering** — keep per-shape `delete → create` chained inside one thunk; never flatten
  delete/create of the same IRI into a single `Promise.all`.
- **Shared cascade helper** — delete-by-id and update must call the *same* helper to avoid drift.

## Architecture compliance

Discovered via `docs/architecture` (CN repo; `@_linked/core` has no local `architecture/` dir — its
docs are `ideas`/`reports`). Relevant docs:

- **[05-code-as-canonical](../../../../docs/architecture/05-code-as-canonical.md) (primary).** Defines
  "code-native structures → queryable graph metadata" and the code↔graph sync model. `syncShapes()`
  *is* the forward (code → graph) materialization for shapes; **code stays canonical, the store is a
  rebuildable cache** (D1 delete+recreate). Reverse import (graph → code) is **not** in scope →
  backlog.
- **[04-storage-model](../../../../docs/architecture/04-storage-model.md).** Writes go through
  queries → `IDataset`; default graph now (D2); named-graph isolation deferred to `ideas/005`.
- **[10-code-structure](../../../../docs/architecture/10-code-structure.md) §Testing.** Package unit
  logic = Jest in `packages/*/src/**/*.test.ts`; we add jest unit + a Fuseki integration test,
  matching core's established `sparql-fuseki.test.ts` convention (no browser layer in core).

No architecture changes required; one approved deferral (reverse import → backlog).

## Test strategy

**Impacted package:** `@_linked/core` only.

**Quick regression gate (after each phase, ~1-2 min):** `npm test` (jest, `--runInBand`). Source:
`package.json` scripts.

**Unit tests (jest, golden-SPARQL via `captureQuery` + `*ToSparql`):**
1. Ontology terms exist (`shacl.ts`, `linked-core.ts`).
2. `contains`/`dependent` flags stored on PropertyShape/NodeShape and **persisted** in meta-model output.
3. `List` create + `rdfList()` helper → correct ordered `rdf:first`/`rdf:rest`/`rdf:nil` chain
   (golden SPARQL; deterministic ids when `base` given).
4. `serializePathToNodeData` — each `PathExpr` form (simple / seq / inverse / alt / `*` `+` `?`) →
   correct `{id}`/`List`/`PathNode` and golden `sh:path` SPARQL.
5. Full shape serialization — `NodeShape.create(...)` → `sh:NodeShape` + `sh:property` + all
   constraints (golden).
6. Cascade generation — `deleteToAlgebra` for a property shape with list/path follows
   `contains`/`rdf:rest*`, excludes `rdf:nil`, leaves simple predicate IRIs (string assertions, no store).
7. `syncShapes` plan — given a registry + mocked read, routes create vs orphan-delete and returns
   correctly-ordered thunks.

**End-to-end (jest + Fuseki in Docker) — `npm run test:fuseki`** (deferred to review; gated/skipped if
Fuseki unavailable). NEW `src/tests/sparql-fuseki-shape-sync.test.ts`, **reusing the existing core
Fuseki harness** — `src/test-helpers/fuseki-test-store.ts` (`ensureFuseki`, `createTestDataset`,
`deleteTestDataset`, `clearAllData`, `executeSparqlQuery`), `FusekiStore`, `src/tests/docker-compose.test.yml`,
the `test:fuseki` script, and the graceful-skip-when-down pattern from `sparql-fuseki.test.ts`. No new harness:
- **Setup:** `docker-compose.test.yml` (existing) spins Fuseki; create a **dedicated/fresh test
  dataset** (`createTestDataset`); wire `FusekiStore` as the global dispatch (`setQueryDispatch`) so
  the `syncShapes` read + thunks hit Fuseki.
- **Fixture shape package** exercising every feature: scalar props, all constraints
  (min/max/datatype/nodeKind/class/order/group/name/equals/disjoint/hasValue), `sh:in` with **both**
  literals and IRIs, `valueShape`, complex paths (sequence/inverse/alt/cardinality), inheritance, and
  a `contains`/`dependent` user property.
- **Phase A — materialize & store:** run `syncShapes()` → await thunks → SPARQL-query Fuseki →
  assert every shape, property shape, list chain, path structure, and constraint persisted correctly.
- **Phase B — mutate & re-sync (persistence + cleanup):** change the fixtures — alter a constraint,
  add a property, **remove** a property, swap a path **simple↔complex**, **shrink** an `sh:in` list,
  **remove a whole shape** — run `syncShapes()` again → assert:
  - updates persisted (new constraint/property present);
  - orphan property shapes deleted; removed shape gone;
  - old list cells gone (shrunk list has no dangling cells); old path structures gone (no leftover
    `PathNode`/`List` after simple↔complex swap);
  - **safety:** shared enum IRIs, predicate IRIs, and `rdf:nil` still intact.
- **Teardown:** `deleteTestDataset`.

**Full/slow suite (review):** `npm run test:fuseki` (Docker). Skipped in the quick gate because it
needs Docker + container startup; run at phase boundaries that touch the cascade and at review.

## Implementation progress

- [x] P1 ontology terms & contracts
- [ ] P2 contains/dependent flags
- [ ] P3 List/PathNode/rdfList
- [ ] P4 owned-cascade (delete+update)
- [ ] P5 meta-model accessors
- [ ] P6 path translator
- [ ] P7 syncShapes
- [ ] P8 integration + e2e Fuseki

## Task breakdown (phases)

**Dependency graph / parallelism**
```
P1 (ontology+contracts)
  └─ P2 (contains/dependent flags)
        ├─ P3 (List/PathNode/rdfList)        ┐ parallel
        └─ P4 (owned-cascade: delete+update) ┘ (P4 uses hand-crafted shapes as stubs)
              P3 ─┬─ P5 (meta-model accessors) ┐ parallel
                  └─ P6 (path translator)      ┘
                        └─ P7 (syncShapes)  [needs P4,P5,P6,P3]
                              └─ P8 (integration + e2e Fuseki)
```
One commit per phase (code + plan-doc status touch together). Quick gate after each phase:
`npx jest --config jest.config.js -i --testPathPattern='<phase test>'` + a core typecheck
(`npm run compile`; full build is `yarn linked build`). Full gate (`npm run test:fuseki`, Docker)
deferred to P8 / review.

---

### Phase 1 — Ontology terms & contracts  *(no deps; foundational)*
**Files:** `src/ontologies/shacl.ts`, `src/ontologies/linked-core.ts`.
**Tasks:**
- `shacl.ts`: add `ns(...)` consts + `shacl` exports for `equals`, `disjoint`, `hasValue`, `order`,
  `group`, `closed`, `ignoredProperties` (follow existing `_class`/`_in` keyword-rename pattern).
- `linked-core.ts`: add `contains`, `dependent` (predicate terms) and `PathNode` (class IRI) to the
  `coreOntology` export.
**Test spec** (`src/tests/shacl-serialization-ontology.test.ts`):
- `shacl predicates present` — assert `shacl.equals.id === 'http://www.w3.org/ns/shacl#equals'` and
  likewise for disjoint/hasValue/order/group/closed/ignoredProperties.
- `linked-core terms present` — assert `coreOntology.contains.id`, `coreOntology.dependent.id`,
  `coreOntology.PathNode.id` resolve under `https://linked.cm/ont/linked-core/`.
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 2 — `contains` / `dependent` flags (config + storage + persistence)  *(deps: P1)*
**Files:** `src/shapes/SHACL.ts`, `src/utils/Package.ts`.
**Tasks:**
- `SHACL.ts`: add `contains?: boolean` to `ObjectPropertyShapeConfig` (+ base `PropertyShapeConfig`
  if useful); add `contains?: boolean` field to `PropertyShape`; `createPropertyShape` copies
  `config.contains` → `propertyShape.contains`. Add `dependent?: boolean` to the shape config type
  used by `linkedShape` (`ShapeConfig`); add `dependent?: boolean` field to `NodeShape`.
- `Package.ts` `applyLinkedShape`: read `options.dependent` → set `nodeShape.dependent`.
- Persistence (meta-model wiring is finalized in P5, but define the predicates now): `contains` →
  `coreOntology.contains` on the property shape; `dependent` → `coreOntology.dependent` on the node
  shape. Add a `@literalProperty`-style accessor (xsd:boolean) in the P5 meta-model for each.
**Test spec** (`src/tests/shacl-serialization-flags.test.ts`):
- `objectProperty contains stored` — decorate a shape with `@objectProperty({path, shape, contains:true})`;
  assert its `PropertyShape.contains === true`; a property without it → `undefined`/`false`.
- `linkedShape dependent stored` — `@linkedShape({dependent:true})` → assert `Shape.shape.dependent === true`.
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 3 — `List` rewrite + `PathNode` + `rdfList()` helper  *(deps: P1,P2; parallel with P4)*
**Files:** `src/shapes/List.ts` (rewrite), `src/shapes/PathNode.ts` (new), `src/index.ts` (exports).
**Tasks:**
- Rewrite `List`: pure shape, `targetClass rdf.List`, `dependent:true`; `first` (object property,
  `maxCount:1`, **no** contains); `rest` (object property, `maxCount:1`, `valueShape:List`,
  **contains:true**). Remove `items`/`fromItems`/`getContents`/`addItem(s)`/`isEmpty`.
- `rdfList<T>(items, opts?)` helper (export from `List.ts` + barrel): builds nested `List` node-data
  chain terminating at `{id: rdf.nil.id}`; deterministic `__id` `{base}/{i}` when `opts.base` set.
- `PathNode`: new shape, `targetClass coreOntology.PathNode`, `dependent:true`, with **contains**
  object-properties `inversePath`(sh:inversePath), `alternativePath`(sh:alternativePath, valueShape
  `List`), `zeroOrMorePath`, `oneOrMorePath`, `zeroOrOnePath`.
**Test spec** (`src/tests/shacl-list-pathnode.test.ts`, golden via `captureQuery`+`createToSparql`):
- `rdfList two items` — `List`/`rdfList(['a','b'])` create → SPARQL contains `rdf:first "a"`,
  `rdf:rest` to a second cell, second cell `rdf:first "b"` + `rdf:rest rdf:nil`.
- `rdfList deterministic ids` — `rdfList([...], {base:'x/in'})` → cell subjects `<x/in/0>`, `<x/in/1>`.
- `rdfList IRIs not literals` — `rdfList([{id:'ex:A'},{id:'ex:B'}])` → `rdf:first <ex:A>` (IRI term).
- `List.rest is contains, first is not` — assert `List.shape.getPropertyShape('rest').contains===true`
  and `getPropertyShape('first').contains` is falsy; `List.shape.dependent===true`.
- `PathNode dependent + contains` — assert `PathNode.shape.dependent===true` and its operator
  accessors all `contains===true`.
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 4 — Owned-cascade helper, wired into `delete` + `update`  *(deps: P1,P2; parallel with P3)*
**Files:** `src/sparql/irToAlgebra.ts`.
**Stub note:** does not need P3's real shapes — tests hand-craft a NodeShape/PropertyShape with
`contains`/`dependent` flags + a self-referential `rest` to exercise the cascade.
**Tasks:**
- Add `buildOwnedCascade(rootVar, shapeId)` → `{deletePatterns, whereOptional}`: from `rootVar`,
  follow each `contains` property of the shape (and recursively of `dependent` valueShapes) to reached
  nodes; emit wildcard delete `?n ?p ?o`; gate WHERE so a node is collected iff **blank OR
  `?n a ?t` with `?t IN dependentSet`** and `?n != rdf:nil`; use `rdf:rest*` for self-referential
  (`List`) spines. `dependentSet` computed from `getAllShapeClasses()` where `shape.dependent`.
- Wire into `deleteToAlgebra` (extend the existing per-id delete; coexist with `walkBlankNodeTree`).
- Wire into the `update` old-value removal path (`processNodeDataFieldsForUpdate`) so replacing a
  `contains` property also runs the cascade on the old object.
**Test spec** (`src/tests/shacl-cascade.test.ts`, string/structural assertions on generated SPARQL):
- `delete cascades list spine` — delete a property-shape whose `in` points to a List → DELETE block
  includes a `rdf:rest*`-reachable `?cell ?p ?o` and a `FILTER` excluding `rdf:nil`.
- `delete keeps simple predicate` — a property-shape with a simple `sh:path` IRI → cascade does **not**
  emit a delete for that predicate IRI (it's not blank/dependent).
- `update replaces + cascades old list` — update `in` → DELETE old `sh:in` edge **and** old cell spine,
  INSERT new.
- `dependentSet derived from flags` — register a `dependent` test shape; assert its targetClass appears
  in the cascade's type filter; a non-dependent shape's type does not.
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 5 — Extend `Package.ts` meta-model accessors  *(deps: P1,P2,P3; parallel with P6)*
**Files:** `src/utils/Package.ts` (meta-model block ~L540-620).
**Tasks:**
- Add `createPropertyShape(...)` definitions on `NodeShape` for: `closed`(sh:closed, xsd:boolean),
  `ignoredProperties`(sh:ignoredProperties), `dependent`(coreOntology.dependent, xsd:boolean); and on
  `PropertyShape` for: `minCount`, `maxCount`, `datatype`, `nodeKind`, `class`, `in`(valueShape `List`),
  `equals`, `disjoint`, `lessThan`, `lessThanOrEquals`, `hasValue`, `order`, `group`, `name`, `node`
  (valueShape), `contains`(coreOntology.contains, xsd:boolean). Map each to the right `shacl.*`/literal.
- Mark `contains:true` on the meta-model `properties` (sh:property), `path` (sh:path), and new `in`
  (sh:in) property shapes. Leave `path`'s existing `valueShape` untouched (D9).
**Test spec** (`src/tests/shacl-metamodel.test.ts`):
- `NodeShape.create serializes constraints` — `NodeShape.create({targetClass, description, properties:
  [{__id, path:{id:'ex:n'}, minCount:1, datatype:xsd.string, name:'Name'}]}).withId('s')` → golden
  SPARQL with `s a sh:NodeShape`, `s sh:property <s-prop>`, `<s-prop> sh:path ex:n`, `sh:minCount 1`,
  `sh:datatype xsd:string`, `sh:name "Name"`.
- `meta-model contains flags` — assert `NodeShape.shape.getPropertyShape('properties').contains` and
  `PropertyShape.shape.getPropertyShape('path'/'in').contains` are `true`.
**Validation:** quick gate test file passes; `npm run compile` exits 0; no regression in existing
`sparql-mutation-golden`/`metadata` tests (`npx jest -i --testPathPattern='metadata|mutation-golden'`).

---

### Phase 6 — Path write-translator  *(deps: P3; parallel with P5)*
**Files:** `src/shapes/serializePathToNodeData.ts` (new), reuse logic from `src/paths/serializePathToSHACL.ts`.
**Tasks:**
- `serializePathToNodeData(path: PathExpr, base: string)`: `PathRef` → `{id: refIri}`; `{seq}` →
  `rdfList(segments.map(serialize), {base})`; `{inv}` → `{shape:PathNode, __id, inversePath: serialize(inner)}`;
  `{alt}` → `{shape:PathNode, __id, alternativePath: rdfList(...)}`; `{zeroOrMore|oneOrMore|zeroOrOne}` →
  `{shape:PathNode, __id, <op>: serialize(inner)}`; throw on `negatedPropertySet` (as the existing serializer does).
**Test spec** (`src/tests/shacl-path-translator.test.ts`):
- `simple → {id}` — `serializePathToNodeData({id:'ex:a'}, base)` returns `{id:'ex:a'}`.
- `sequence → List` — `{seq:[a,b]}` → node-data whose create SPARQL is an rdf:List of `ex:a`,`ex:b`.
- `inverse → PathNode` — `{inv:'ex:p'}` → `sh:inversePath ex:p` on a `linked:PathNode`-typed node.
- `alternative → PathNode+List`; `zeroOrMore → sh:zeroOrMorePath`; assert each golden.
- `nested ^(a/b)` — inverse-of-sequence → `PathNode{ sh:inversePath: List(a,b) }`.
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 7 — `syncShapes()` orchestrator  *(deps: P3,P4,P5,P6)*
**Files:** `src/shapes/syncShapes.ts` (new), `src/index.ts` (export).
**Tasks:**
- Enumerate `getAllShapeClasses()`, exclude `constructor.packageName === '@_linked/core'` (D4).
- Identity-read existing `sh:NodeShape` / `sh:PropertyShape` subjects (via `Shape.select`/`selectAll`
  or a `SHACLNodeShape`-style select) — for **orphan detection only**.
- Build per-shape data via `NodeShape.create({...}).withId(shapeIri)` using P5 accessors + P6 path
  translator + `rdfList` for `in`; property-shape `__id = {shapeIri}/{label}` (D-decisions).
- Return `Array<() => Promise<void>>`: per in-code shape a `() => delete(shapeIri)...then(create)`
  thunk (delete cascades via P4); plus orphan-delete thunks for store-only shapes/property-shapes.
- `options.dataset` overrides the global dispatch for the read (testability).
**Test spec** (`src/tests/shacl-syncshapes.test.ts`, mocked read/dispatch — no Fuseki):
- `returns thunks` — assert return is array of functions.
- `routing` — given a registry with shapes {A new, B existing} and store with {B, C orphan}: assert
  thunk set covers A (create), B (delete→create), C (orphan delete); each thunk’s captured queries
  are correct kinds/ids.
- `excludes framework shapes` — NodeShape/PropertyShape/List/PathNode not present in the plan.
- `per-shape ordering` — a single shape's thunk issues delete **before** create (capture order).
**Validation:** quick gate test file passes; `npm run compile` exits 0.

---

### Phase 8 — Integration + e2e Fuseki  *(deps: P7; final)*
**Files:** `src/tests/sparql-fuseki-shape-sync.test.ts` (new), `src/index.ts` (verify barrel).
**Tasks:** wire real components end-to-end; verify barrel exports; author the e2e test (reusing
`fuseki-test-store` + `FusekiStore` + `docker-compose.test.yml` + `test:fuseki`, graceful-skip if down).
**Test spec** — see **Test strategy → End-to-end** above (Phase A materialize→store→assert; Phase B
mutate→re-sync→assert persistence + orphan/cell/path cleanup + safety for enum IRIs / predicate IRIs
/ `rdf:nil`; dedicated dataset; teardown).
**Validation:**
- Quick gate: full unit suite `npm test` exits 0; `npm run compile` exits 0.
- **Full gate (required this phase):** `npm run test:fuseki` — all e2e cases green (or cleanly skipped
  only if Docker truly unavailable; must be run before review sign-off).
- Final build: `yarn linked build` succeeds.

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
- Heavier first-class `{__rdfList}` IR/mutation-engine primitive (the public `rdfList()` helper in
  D6 covers the ergonomics without it).
- Reverse import (SHACL RDF → NodeShape) round-trip.
