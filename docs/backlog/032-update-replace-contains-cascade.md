---
summary: When a DSL `update()` REPLACES a `contains` (owned) object property, the old node's own triples are left behind — it becomes an orphan. The replace path (irToAlgebra `processUpdateFields`) removes the one-hop edge and cascades the old value's dependent-typed *descendants* (`buildOwnedCascade`), but never deletes the immediate old contained node's own triples. Explicit `delete()` of a parent works; replace-on-update does not.
packages: [core]
---

# 032 — update-replace of a `contains` property orphans the old node

> Source: plan-011 T9.3 (WorkspaceProvider image write → DSL). `Thing.image` was
> given `contains: true` (the correct modeling — an entity owns its ImageObject),
> but replacing a workspace image via `Workspace.update({image: {contentUrl}})`
> still leaves the previous ImageObject in the graph.

## Repro (verified)
```ts
await Workspace.update({image: {contentUrl: 'a'}}).for({id: ws});  // ImageObject#1 {contentUrl a}
await Workspace.update({image: {contentUrl: 'b'}}).for({id: ws});  // ImageObject#2 {contentUrl b}
// ws schema:image → ImageObject#2   (read returns 'b' — correct)
// ImageObject#1 { a schema:ImageObject ; schema:contentUrl 'a' }  ← ORPHAN, still in the graph
```
Read-correctness is fine (`image.contentUrl` follows the current link). Only graph
cleanliness suffers: orphan `ImageObject` nodes accumulate across image changes.

## Why (root cause)
`irToAlgebra.processUpdateFields` — the non-set-modification replace path (single
nested object / array overwrite / unset):
1. DELETEs the one-hop edge `<subject> <prop> ?old` (line ~1888).
2. For a `contains` field, pushes `old_<suffix>` to `containsOldVars`, then calls
   `buildOwnedCascade(old_<suffix>)` (line ~1952).

But `buildOwnedCascade(root)`:
- Requires `dependentTypes.length > 0` — nodes whose **shape** is marked
  `dependent: true`. `ImageObject` is not `dependent`, so the cascade is a no-op.
- Even when it runs, it deletes nodes **reached from `root` via `contains` edges**
  (root's descendants) + their triples — **not `root`'s own triples**. So the
  immediate replaced node is never removed regardless.

Contrast: `Shape.delete(parent)` / `deleteToAlgebra` correctly removes the owned
subtree, and set-modification `update({prop: {remove: [x]}})` cascades `x`
(`buildOwnedCascade` on the removed item) — but a plain replace does not delete
the immediate old value.

## Fix options
1. **Replace-path delete of the old node's own triples.** In the replace branches,
   when `isContainsField`, also emit `DELETE { ?old ?p ?o } WHERE { OPTIONAL { <s> <prop> ?old . ?old ?p ?o } }`
   (guarded so it only fires for owned/`contains` values — safe because a `contains`
   value is exclusively owned). This deletes ImageObject#1 fully on replace.
2. **Make cascade include the root**, and drop the `dependent`-type gate for
   `contains` values (a `contains` edge already asserts ownership). Broader change
   to `buildOwnedCascade` — audit `dependent` callers first.
3. Require owned child shapes to be `dependent: true` AND fix (2) — belt-and-braces.

Option 1 is the most targeted. Add a test extending
`tests/integration/workspace-image-dsl.spec.ts` (currently asserts the orphan
count == 2 to codify present behavior; flip to == 1 when fixed).

## Related
- Property `contains` flag: `SHACL.ts`, `Package.ts`; cascade: `irToAlgebra.ts`
  (`buildOwnedCascade`, `collectContainment`, `deleteToAlgebra`).
- Shape `dependent` flag drives `dependentTypes`.
