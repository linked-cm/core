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

`.exists()` returns a real `Promise<boolean>` and never catches: a store, transport or
lowering failure rejects, including an unresolved query-context reference in a where
clause (which `exec()` still reports as `null`, unchanged).

It also normalises the query to its cheapest correct form first. Dropped: the projection,
preloads, sorting and pagination — none of them can change whether a *match* exists, and
honouring `offset` while dropping the projection could actively flip the answer, since
`OFFSET` skips rows of a solution sequence whose cardinality depends on the projection.
Kept: filters, `minus` entries and the subject. So
`Person.select(p => p.name).orderBy(…).offset(10).exists()` costs and answers exactly the same
as a bare `Person.exists({id})`.

See the ask-query entry in this release for what that normalised query becomes on the wire and in
SPARQL: `.exists()` is a shortcut for an ask query, which is its own query kind with its own
`IDataset.askQuery` method.
