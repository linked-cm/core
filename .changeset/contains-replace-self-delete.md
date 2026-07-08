---
"@_linked/core": patch
---

Fix: a DSL `update()` that replaces, unsets, or set-removes a `contains` (owned) object property now deletes the previously-owned node's own triples instead of leaving it as an orphan in the graph. Previously only the one-hop edge was unlinked (and dependent-typed *descendants* cascaded), so e.g. replacing a `contains`-owned `ImageObject` via `Workspace.update({image: {contentUrl}})` accumulated stale `ImageObject` nodes.

The cleanup is driven by the property's `contains` flag (exclusive ownership) and does **not** require the owned child shape to be marked `dependent`. It is safe when there is no prior value (the owning edge is bound in-query, so a missing old value is a no-op).

New internal export `buildOwnedSelfDelete` in `src/sparql/irToAlgebra.ts` (mirrors `buildOwnedCascade`) for lowering/testing.
