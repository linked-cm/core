---
'@_linked/core': minor
---

Serialize code-defined SHACL shapes into the store and keep them in sync.

**New exports**

- `syncShapes(): Promise<Array<() => Promise<void>>>` — materializes every code-registered
  (non-framework) `NodeShape` into the store as SHACL data. Returns built-but-unexecuted thunks so the
  caller controls execution/batching; each thunk runs `delete → recreate` for one shape (cascade-cleaning
  its old property shapes / list / path subtrees), plus orphan-delete thunks for shapes removed from code.
  ```ts
  import {syncShapes} from '@_linked/core';
  await Promise.all((await syncShapes()).map((run) => run()));
  ```
- `rdfList(items, {base?})` — builds an ordered `rdf:List` (nested `List` node-data) for use in any
  create/update, so ordered collections (and `sh:in`) round-trip instead of becoming unordered sets:
  ```ts
  Playlist.create({ tracks: rdfList([t1, t2, t3]) });
  ```
- `serializePathToNodeData(pathExpr, baseIri)` — translates a `PathExpr` to `sh:path` node-data
  (predicate IRI / `rdf:List` sequence / `PathNode` for inverse·alternative·cardinality).
- `PathNode` shape (`linked:PathNode`) — operator node for complex property paths.

**New composition flags (delete/update cascade)**

- `@objectProperty({ …, contains: true })` marks a property as owning its value(s); `@linkedShape({
  dependent: true })` marks a shape whose instances may be cascade-deleted when reached through a
  `contains` edge. Deleting or replacing a `contains` property now removes the whole owned subtree
  (e.g. an `rdf:List` spine or a `sh:path` operator tree), while shared predicate/value IRIs and
  `rdf:nil` are preserved.
- `@linkedShape({ closed: true, ignoredProperties: [...] })` now persist as `sh:closed` /
  `sh:ignoredProperties`.

**New SHACL/ontology terms:** `sh:equals`, `sh:disjoint`, `sh:hasValue`, `sh:order`, `sh:group`,
`sh:closed`, `sh:ignoredProperties`; `linked_core:contains`, `linked_core:dependent`, `linked_core:PathNode`.

**Potentially breaking:** the `List` shape was rewritten to a pure `rdf:List` cell shape — its former
in-memory helpers (`fromItems`, `getContents`, `addItem(s)`, `isEmpty`, `items`) were removed. Use
`rdfList()` to build lists. `List` had no RDF-backed consumers, so most users are unaffected.

See `docs/reports/016-shacl-rdf-serialization.md` for the full design, cascade mechanics, and test coverage.
