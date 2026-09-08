---
'@_linked/core': minor
---

Ask queries — a first-class query kind whose answer is a boolean — plus two `rdf:type` / `sh:path`
resolution fixes it surfaced.

## Ask queries

`.exists()` is a shortcut for an ask, not a special case of select. An ask carries a **pattern and
nothing else** — no projection, sorting or pagination — at every layer: `AskBuilder`, `IRAskQuery`,
an `op: 'ask'` wire envelope, and `ASK WHERE { … }` in SPARQL.

```ts
await Person.exists({id});                                           // ASK { ?a0 a <PersonClass> . FILTER(?a0 = <id>) }
await Person.select().where((p) => p.name.equals('Semmy')).exists();  // ASK with the filter
await Shape.exists(uri);                                             // ASK { <uri> ?p ?o }
```

**`Shape.exists(uri)` on the base class asks whether a node exists at all** — no `rdf:type`
constraint, under any shape or none. (`Shape` is free to mean "anything": the shapes themselves are
described by `NodeShape` and `PropertyShape`.) A shapeless ask has no shape to route on, so
`LinkedStorage` asks **every** dataset it knows and ORs the answers, short-circuiting on the first
`true` — cheap precisely because the answers are booleans. Any router implementing `IDataset`
inherits that obligation: a shapeless ask means "anywhere I can reach", not "in my default store".

### Breaking: `IDataset.askQuery(query: AskQuery): Promise<boolean>` is required

Every store must implement it; `query.shape` is optional. **No code path in this package rewrites an
ask as a select** — a store with no boolean primitive decides for itself how to answer, and
defaulting that here would hide the choice. `askQuery` must resolve to a real boolean (a non-boolean
is rejected, not coerced, since a truthy value would read as "exists") and must reject on failure.

### Wire format `1.1`

An ask travels as its own envelope, discriminated by `op: 'ask'`:

```json
{"v": "1.1", "op": "ask", "shape": "…/Person", "subject": "…/p1"}
{"v": "1.1", "op": "ask", "subject": "https://example.org/thing"}
```

Omitting `shape` **is** the shapeless form. There is no `fields`, `limit`, `offset`, `sortBy` or
`one`, so a receiver has nothing to validate or ignore. `fromJSON` routes `op: 'ask'` to an
`AskBuilder` and still throws `Unknown query op` on anything unrecognised, so an older peer fails
loud rather than reinterpreting the envelope as a select. Deploy receivers first.

New exports: `AskBuilder`, `isAskQuery`, and the `AskQuery` / `AskQueryJSON` / `RawAskInput` /
`AskSpec` types. `lower()` gains an ask overload returning `IRAskQuery`; `askToAlgebra` /
`askToSparql` / `askPlanToSparql` / `SparqlAskPlan` / `mapSparqlAskResult` are the SPARQL arm.

## Breaking: a shape must declare a `targetClass`

A query or mutation on a shape with none — on it or on any shape it extends — now throws instead of
silently typing instances with the shape's own IRI.

```ts
@linkedShape
class Person extends Shape {
  static targetClass = {id: 'https://example.org/Person'};  // required
}
```

`rdf:type` names the class a node **is**; the shape IRI identifies the SHACL description *of* that
class — a different node. Substituting one for the other conflated them, and did so invisibly: read
and write used the same substitution, so data round-tripped and nothing surfaced the mistake.
`targetClass` is read off the shape class, so JavaScript static inheritance already walks the
superclass chain.

## A declared `sh:path` is always the predicate

The resolver skipped any shape or property IRI beginning `linked://tmp/`, substituting the property
shape's own "shadow" IRI. That skip existed only so this repo's fixtures could assert shape-derived
predicates; it is gone, along with the `linked://tmp/` special case. Two mutation paths that built
traversal predicates by hand — bypassing the resolver — now go through it, fixing an expression
update (`p.bestFriend.name`) that emitted the shadow IRI as a predicate and therefore matched
nothing.

## Migration

- Declare a `targetClass` on any shape lacking one. Data written under the old behaviour is typed
  with the shape IRI: either set that IRI as the `targetClass`, or retype the nodes.
- Implement `askQuery` on any `IDataset`.
- A shape declaring a `linked://tmp/` path gets its declared path as the predicate instead of the
  shadow IRI. No released code minted such IRIs, so this is expected to affect nobody.
