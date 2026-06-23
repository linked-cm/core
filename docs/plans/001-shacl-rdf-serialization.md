---
summary: Serialize registered NodeShapes to the store as SHACL via the query engine (meta-shapes + rdfList primitive + syncShapes upsert). Supersedes ideation in ideas/015.
status: Ideation
source: ideas/015-shacl-rdf-serialization.md
related: ideas/013-shacl-property-paths.md, ideas/005-named-graph-support.md, reports/011-shacl-property-paths-and-prefix-resolution.md
---

# SHACL Shape Serialization & Sync — Active Plan

Active working doc for implementing `ideas/015`. One doc from ideation → review.

## Problem & chosen direction

NodeShape/PropertyShape carry rich SHACL metadata that is never persisted. We want
shapes defined in code to be written to the store as SHACL data so they are queryable
and loadable into validation-enabled triplestores. **Code is canonical; the store is a
rebuildable projection.**

Decided with the user (reframes Routes A/B/C of ideas/015):

- **Output is queries, not an intermediate RDF artifact.** `syncShapes()` returns
  `Create`/`Update`/`Delete` queries; awaiting them updates the store. No `Triple[]` public API.
- **Dogfood the engine via meta-shapes** (Route B): `SHACLNodeShape` / `SHACLPropertyShape`
  are real `@linkedShape` classes whose `targetClass` is `sh:NodeShape` / `sh:PropertyShape`,
  with decorated accessors per SHACL predicate. Creating instances of them produces the queries.
- **Named, deterministic IRIs** (no blank nodes): shape IRI = `getNodeShapeUri(pkg, Name)`;
  property-shape IRI = `{shapeIri}/{accessorLabel}` (already assigned by `registerPropertyShape`);
  list/path cells skolemized under the property-shape IRI. Named nodes are addressable for
  re-sync (blank nodes are not) and are valid SHACL.
- **Full scope this branch:** complex `sh:path` (sequence/inverse/alt/cardinality) **and**
  `sh:in` are supported, which requires a real ordered-list primitive in the mutation engine.

## Resolved design

### Meta-shapes (`@_linked/core`)
`SHACLNodeShape` (targetClass `sh:NodeShape`) with accessors: `targetClass`, `closed`,
`ignoredProperties`, `description`, `property[]` (→ `SHACLPropertyShape`).
`SHACLPropertyShape` (targetClass `sh:PropertyShape`) with accessors for every PropertyShape
field: `path`, `class`, `datatype`, `nodeKind`, `minCount`, `maxCount`, `name`, `description`,
`order`, `group`, `equals`, `disjoint`, `lessThan`, `lessThanOrEquals`, `hasValue`, `in`,
`node` (valueShape). Coexist safely with the built-in `NodeShape`/`PropertyShape` classes:
the global registry is keyed by **shape IRI** (distinct), and `typesToShapes` keeps a *set*
per targetClass — shared targetClass is allowed.

### `rdfList` ordered-list primitive (Route 2 + skolemization Route 1)
- New IR field-value variant (e.g. `{__rdfList: IRFieldValue[], base?: string}`) recognised in
  `generateNodeDataTriples` (`src/sparql/irToAlgebra.ts`), lowered to an `rdf:first`/`rdf:rest`/
  `rdf:nil` chain. Cells get deterministic IRIs `{base}/0`, `{base}/1`, … when `base` is set;
  blank nodes otherwise (general-purpose default).
- A public helper to construct the wrapper from the DSL side. Items reuse `fieldValueToTerms`,
  so list members may be literals or IRIs (covers `sh:in` of literals or IRIs, and path lists).

### Complex `sh:path`
Reuse `serializePathToSHACL`'s structure but **skolemized**: `sh:path` object is the IRI for a
simple ref; otherwise a skolem node `{psIri}/path…` with `sh:inversePath` / `sh:alternativePath`
/ `sh:zeroOrMorePath` / …; sequences and the inside of `alternativePath` use the `rdfList`
primitive. Single predicate↔field map shared by export (and a future importer).

### Missing SHACL predicates to add to `src/ontologies/shacl.ts`
`sh:equals`, `sh:disjoint`, `sh:hasValue`, `sh:order`, `sh:group`, `sh:closed`,
`sh:ignoredProperties` (others already exist).

### `syncShapes()` upsert
1. Enumerate registered shapes via `getAllShapeClasses()`, **excluding framework shapes**
   (`constructor.packageName === '@_linked/core'`, which also drops the meta-shapes themselves).
2. Identity-read the store: which `sh:NodeShape` / `sh:PropertyShape` IRIs already exist.
3. Route each local subject: new → `Create.withId(iri)`; existing → `Update.for(iri).set(...)`;
   in store but not local → `Delete`. No field-level diffing — overwrite every field.
4. NodeShape update overwrites the multi-valued `sh:property` set (removed property shapes get
   unlinked); orphan property-shape subjects deleted via the identity read.

## Implementation outline (todos)

1. Add missing SHACL predicates to `shacl.ts`.
2. `rdfList` primitive: IR variant + lowering in `irToAlgebra.ts` (+ blank/skolem cells) + DSL helper.
3. Meta-shapes `SHACLNodeShape` / `SHACLPropertyShape` with decorated accessors.
4. Complex `sh:path` serialization (skolemized, reuse `serializePathToSHACL` structure + `rdfList`).
5. `syncShapes()`: enumerate → identity-read → emit create/update/delete-orphan queries.
6. Tests (jest, golden-SPARQL style via `captureQuery` + `createToSparql`): rdfList, meta-shape
   serialization, complex paths, `sh:in`, sync upsert/delete.
7. `yarn linked build` + run suite; fix.

## Accepted decisions (ideation)

- **D1 — Re-sync cleanup = read + delete-subtree + recreate per shape (option A).**
  Identity-read existing shape/property/cell IRIs; for each in-code shape, delete its existing
  subtree then create fresh; delete orphan shapes/property-shapes no longer in code. One code
  path, robust for lists/complex paths, deterministic end state. *Rejected:* hybrid in-place
  update (B — two code paths, still must clean cells); full global rebuild (C — most churn,
  same reachability problem at global scope). *Confirmed:* `updateToAlgebra` replace is one-hop
  (`subject predicate oldObj`) and never reaches list/path cell subtrees → in-place update would
  orphan old cells, which is why delete-subtree+recreate wins.
- **D2 — Default graph (option A).** Named-graph writes are not implemented (idea 005 is a
  proposal — DSL writes the default graph only). Graph isolation is deferred to 005, not pulled
  into this branch. *Rejected:* implementing named-graph write here (scope jump); optional graph
  stub param (misleading no-op).
- **D3 — `syncShapes` API (option A).** Zero-arg; reads current state via the global query
  dispatch; **returns built-but-unexecuted** Create/Update/Delete queries so the caller runs
  `await Promise.all(queries)` and controls batching/transactions. Optional injected executor
  for tests. *Rejected:* mandatory injected executor (ceremony); fully-managed execute-internally
  (hides the queries the user wants returned).
- **D4 — Framework-shape exclusion** by `constructor.packageName === '@_linked/core'` (also drops
  the meta-shapes themselves), not IRI-substring matching.

## Verification items for plan mode (nested unknowns, not user decisions)

- **Cell-enumeration read (the one real unknown for D1):** how `syncShapes` reads the existing
  recursive list/path cell IRIs under a shape for clean deletion — `rdf:rest*` traversal,
  typed cells, or deterministic-IRI enumeration. Pin the exact mechanism in plan.
- Nested-node lowering works through **update** (`updateToAlgebra`), not just create.
- `getAllShapeClasses()` is populated at sync time (decorators have run / bundling).
- Confirmed: `UpdateBuilder.set` = delete-old + insert-new (replace) at the predicate level.
- Confirmed: `Shape.select` / `selectAll` read path exists for the identity read.
