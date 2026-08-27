---
"@_linked/core": minor
---

`syncShapes` can scope its orphan sweep to the namespaces it owns.

The sweep previously pruned every store-only shape it found. In a **multi-writer** dataset — an app-data store written by more than one package — that means one writer's sync deletes shapes another writer legitimately owns.

```ts
await syncShapes(shapes, {orphanScope: 'ownedNamespaces'});
```

- `'all'` *(default, unchanged)* — prune every store-only shape. Correct when the sync is the sole writer.
- `'ownedNamespaces'` — only prune shapes in namespaces this sync owns.
- `'none'` — never prune.

Additive: omit the option and behaviour is exactly as before.
