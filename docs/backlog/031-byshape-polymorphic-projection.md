---
summary: A query-time polymorphic projection — `value.byShape([[List, l => …], [PathNode, p => …], fallback])` — so the DSL can read a shapeless/polymorphic object property differently depending on the runtime shape of each value ("if this shape then get X, if that shape then get Y"). Driving case: reading full `sh:path` structure (predicate IRI vs rdf:List sequence vs PathNode operator) instead of just its node ref. Complements 030 (SHACL path reader) and 013 (mutation-side shapeless values).
packages: [core]
---

# 031 — `byShape` polymorphic projection (read a value by its runtime shape)

> Source: plan-011 Phase T9 (getShapeCatalog → DSL). Shipped there: **Option B** —
> a shapeless IRI-valued object property (`SelectQuery.generatePathValue`) now
> projects the value's **node reference `{id}`** instead of throwing "No shape set
> for objectProperty". That was enough to migrate the shape catalog (property
> paths are simple predicate IRIs in ~all shapes today). This item is the *next*
> layer: reading the **structure** of polymorphic values.

## The gap

Some object properties are **polymorphic** — the same property holds values of
different shapes at runtime. The canonical case is `sh:path` (registered in
`Package.ts` with **no** value shape, deliberately — see its comment):

| `sh:path` value | shape | what we want to read |
|---|---|---|
| a plain predicate IRI | (bare IRI) | the IRI — `{id}` ✅ Option B handles this |
| an `rdf:List` `( a b )` | `List` | the ordered member IRIs — `{id}[]` ❌ |
| `[ sh:inversePath P ]` etc. | `PathNode` | the operator + operands ❌ |

Today (post-Option-B) a List / PathNode value resolves to its **node ref** (a
blank-node `{id}`), not its structure — same limitation the old raw SPARQL had.
To read the *structure* via the DSL, the projection must branch on each value's
runtime shape.

## Proposed API

```ts
NodeShape.select(ns => [
  ns.properties.select(ps => [
    ps.path.byShape([
      [List,     l  => l.members],              // sequence → ordered members
      [PathNode, pn => [pn.inversePath, /*…*/]], // operator → operands
      /* fallback */ iri => iri,                 // simple IRI → the ref (Option B)
    ]),
  ]),
]).exec(store)
```

Result: each value is projected by the first matching `[Shape, fn]` arm
(dispatched on the value's `rdf:type` / detected shape), falling back to the
node ref. This is a **general** capability — any shapeless/polymorphic relation
benefits, not just `sh:path`.

## Relation to existing items
- **030 — SHACL `sh:path` → `PathExpr` reader.** 030 is the path-specific,
  shape-sync-oriented reader (RDF → `PathExpr`, so `loadShapesFromDataset` can
  reconstruct paths). `byShape` is the *general query-projection* primitive; the
  `sh:path` arm of a `byShape` projection would produce the same structural data
  030 needs. Decide whether 030 is implemented on top of `byShape` or standalone.
- **013 — Nested builder/Shape values for shapeless properties.** The
  *mutation* analog: writing a nested node under a shapeless property (the value
  self-describes its shape). `byShape` is the read/query counterpart.
- **029 — query type system refactor.** `byShape`'s result typing (a union over
  the arms) likely rides along here.

## Consumers of `PropertyDetails.path` today (why "all details" matters soon)
Reviewed for T9. Current consumers read only the **predicate IRI**
(`Array.isArray(path) ? path[0]?.id : path?.id`), so Option B is sufficient *for
them* today:
- `runtimeShapeRegistry.ts` — `normalizePropertyPath(pathInput(prop.path))`: the
  predicate the **CRUD** pipeline emits. Needs the real predicate; complex paths
  would need structure to emit correct SPARQL.
- `sparql.ts`, `displayProperties.ts`, `DraftProvider.ts`, `ProjectProvider.ts`
  — predicate matching / display / drafts / dedup; all first-predicate today.

**The Shape Builder is the consumer that will force this.** Authoring/editing a
shape whose property uses an inverse/sequence/alternative path needs to *read and
render the full path* (and round-trip it on save). When complex paths land in the
builder, `{id}|{id}[]` and Option-B node-refs are no longer enough — that's the
trigger to implement `byShape` (+ 030) and widen `PropertyDetails.path` to a
`PathExpr`-shaped type.

## Technical sketch
- Query build: emit a UNION-like structure (one branch per arm's shape) under the
  property, or an unconstrained object projection + post-hoc dispatch.
- Result decode: for each value, detect its shape (rdf:type / structural probe),
  run the matching arm's projector, else the fallback.
- Typing: result type = union of the arms' return types (see 029).

## Acceptance (when picked up)
- `ps.path.byShape([...])` reads: simple IRI → `{id}`; `( a b )` → members;
  `[ sh:inversePath p ]` → the operator structure — verified against a Fuseki
  store seeded with all three path forms.
- The T9 shape-catalog parity test extends to complex paths (currently only
  simple predicates are asserted).
- No regression to Option B (shapeless IRI → node ref) for callers that don't opt
  into `byShape`.
