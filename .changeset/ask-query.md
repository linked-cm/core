---
'@_linked/core': minor
---

Ask queries — a first-class query kind whose answer is a boolean.

`.exists()` is now a shortcut for an ask, not a special case of select. An ask carries a **pattern
and nothing else**: no projection, sorting or pagination, at every layer — `AskBuilder`,
`IRAskQuery`, the `op: 'ask'` wire envelope, and `ASK WHERE { … }` in SPARQL.

```ts
await Person.exists({id});                                          // ASK { ?a0 a <Person> . FILTER(?a0 = <id>) }
await Person.select().where((p) => p.name.equals('Semmy')).exists(); // ASK with the filter
await Shape.exists(uri);                                            // ASK { <uri> ?p ?o }
```

**`Shape.exists(uri)` on the base class asks whether a node exists at all** — no `rdf:type`
constraint, under any shape or none. (`Shape` is free to mean "anything": the shapes themselves are
described by `NodeShape` and `PropertyShape`.) Since a shapeless ask has no shape to route on,
`LinkedStorage` asks **every** dataset it knows and ORs the answers, short-circuiting on the first
`true` — cheap precisely because the answers are booleans. Any router implementing `IDataset`
inherits that obligation: a shapeless ask means "anywhere I can reach", not "in my default store".

**Breaking: `IDataset.askQuery(query: AskQuery)` is required, and takes an `AskQuery`.**

```ts
askQuery(query: AskQuery): Promise<boolean>;   // query.shape is optional
```

**There is no path in this package that rewrites an ask as a select.** A store with no boolean
primitive decides for itself how to answer — that decision belongs to the store, and defaulting it
here would hide it. `askQuery` must resolve to a real boolean (a non-boolean is rejected, not
coerced) and must reject on failure.

**Wire format `1.1`** — ask travels as its own envelope, discriminated by `op: 'ask'`:

```json
{"v": "1.1", "op": "ask", "shape": "…/Person", "subject": "…/p1"}
{"v": "1.1", "op": "ask", "subject": "https://example.org/thing"}
```

Omitting `shape` *is* the shapeless form. There is no `fields`, `limit`, `offset`, `sortBy` or
`one` — a receiver has nothing to validate or ignore. `fromJSON` routes `op: 'ask'` to an
`AskBuilder`, and still throws `Unknown query op` on anything it does not recognise, so an older
peer fails loud rather than reinterpreting the envelope as a select. Deploy receivers first.

New exports: `AskBuilder`, `isAskQuery`, and the `AskQuery` / `AskQueryJSON` / `RawAskInput` /
`AskSpec` types. `lower()` gains an ask overload returning `IRAskQuery`; `askToAlgebra` /
`askToSparql` now take one.
