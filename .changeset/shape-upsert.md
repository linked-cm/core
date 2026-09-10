---
'@_linked/core': minor
---

`Shape.upsert()` — create-or-replace against a known id, in one request.

```ts
await SourceDocument.upsert({filename, checksum}).for({id});
```

It replaces the branch callers otherwise hand-roll:

```ts
if (await S.exists({id})) await S.update(values).for({id});
else                      await S.create({id, ...values});
```

which costs two round-trips, races between them, and — if the existence check is wrong in the
`false` direction — silently takes `create`, where `INSERT DATA` duplicates single-valued
properties instead of erroring.

**Semantics**

- Replaces **only the properties named**; others on an existing node are untouched. It is not a
  whole-node replace.
- Always asserts the node's type. `update().for({id})` does not — an update against an absent id
  writes its properties onto an untyped node that shape-scoped selects cannot find. That single
  triple is the entire difference between the two: `update`'s `WHERE` is a bare `OPTIONAL`, so it
  already matches when the node is missing.
- Returns what `update` returns. It deliberately does not report whether it created or replaced —
  knowing that needs the extra read the single round-trip exists to avoid.
- `.where()` and `.forAll()` throw: an upsert targets one known id.
- Expression-valued fields throw. An expression reads the node's current value, which does not
  exist when upsert creates it, and SPARQL would silently drop the triple.

**Wire format** — a new `op: "upsert"` envelope (`mode` is always `"for"`), documented in
`documentation/dsl-json.md`. It is a distinct `op` rather than a new `mode` on `update` so that a
consumer which does not understand it fails loudly instead of falling through to an
update-every-instance.

**IR** — a new `IRUpsertMutation` kind, with `upsertToAlgebra` / `upsertToSparql` alongside the
update equivalents.
