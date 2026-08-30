---
'@_linked/core': minor
---

Add a boolean existence check to the query API: `Shape.exists(id)` and a terminal
`.exists()` on the select builder.

```ts
if (await SourceDocument.exists({id})) {
  await SourceDocument.update(values).for({id});
} else {
  await SourceDocument.create({id, ...values});
}

// or, for "does anything match?"
await Person.select().where((p) => p.name.equals('Semmy')).exists();
```

Until now "does this node exist?" had no direct expression. The natural workaround —
`select().where(…).one()` — resolves to a row or `null`, so callers wrap it in a
`.catch(() => null)` and convert; that swallow makes an unreachable store
indistinguishable from a missing node, silently turning every
`exists ? update : create` into an unconditional `create`.

`.exists()` returns a real `Promise<boolean>` and never catches: a store or transport
failure rejects. It also normalises the query to its cheapest correct form first —
projection, preloads and sorting are dropped (none of them can change *whether* a row
exists), `LIMIT 1` is forced — so `Person.select(p => p.name).orderBy(…).exists()` emits
the same minimal `SELECT DISTINCT ?a0 … LIMIT 1` as a bare `Person.exists({id})`.

Purely additive. No IR, algebra, wire-format or `IDataset` change — it lowers to an
ordinary SELECT, so every store implementation supports it as-is.
