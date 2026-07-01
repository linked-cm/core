---
'@_linked/core': minor
---

DSL-JSON is now the compact, **IR-free "Z-c" wire grammar**. `query.toJSON()` no longer embeds
`IRExpression` in where-clauses or `{kind:…}` value tags in mutations — the wire reads like the DSL,
and `fromJSON()` rehydrates it losslessly (`lower(fromJSON(query.toJSON())) ≡ lower(query)`).

(Pre-adoption, so this ships as a minor despite the wire-shape change — there are no published
consumers of the old format to protect.)

**Where-clauses** are path-keyed conditions with an S-expr fallback:

```jsonc
{ "where": { "name": "Alice", "age": { ">": 18 } } }        // implicit equals + implicit AND
{ "where": { "friends.some": { "name": "Moa" } } }          // quantifiers: some / every / none
{ "where": ["<", ["+", ["STRLEN", {"path":"name"}], 10], 100] }  // computed → S-expr array
```

Values follow one grammar: a bare scalar is a literal; `{id}` a node ref; `{$ctx}` / `{$ctx,path}` a
query-context reference; `{date}`, `{list}`, `{unset}`, `{add,remove}` the tagged kinds; a computed
value is an S-expr.

**Projections** use bare dotted-string leaves (`"name"`, `"friends.friends.name"`), `{as, value}` for
computed fields, scoped relation filters, and inline `as(<ShapeLabel>)` casts.

**Mutations** carry path-keyed node data:

```jsonc
{ "op":"create", "shape":"…/Person",
  "data": { "name":"Alice", "bestFriend": { "name":"Bestie" }, "friends": { "list":[ {"id":"…"} ] } } }
```

with reserved `__id` (a fixed/predefined id) and `__shape` (the concrete shape, emitted only for a
subclass instance under a superclass-typed relation).

**Envelope:** `sortBy` is now an ordered array of `{path: direction}` (element order = precedence);
`.one()` serializes as `one` (was `singleResult`); the deprecated `orderDirection` is gone.

**Breaking / behavioral notes**

- The wire shape of `query.toJSON()` changed across the board; anything that read the old
  IR-embedding / `{shape,fields}` / `{kind:…}` forms must move to the Z-c grammar.
- The exported types `MutationValueJSON` and `MutationNodeDataJSON` changed shape accordingly.
- `and`, `or`, and `not` are now **reserved property labels** (they are boolean combinators in a
  where-clause and have no key-position escape) — declaring a property with one of those names throws
  at shape registration.

See the full [DSL-JSON specification](./documentation/dsl-json.md). Deferred edge items are tracked
in `docs/backlog/002-dsl-json-zc-open-items.md`.
