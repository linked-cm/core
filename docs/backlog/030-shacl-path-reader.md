---
summary: Add the reverse `sh:path` → `PathExpr` reader so SHACL shape sync is bidirectional. The *write* side (PathExpr → sh:path RDF, via the query engine) shipped in report 016; there is still no reader, so a shape authored as RDF/Turtle (or stored in the graph) cannot have its property paths reconstructed into `PathExpr` and its relations are not queryable.
packages: [core]
---

# 030 — SHACL `sh:path` → `PathExpr` reader (bidirectional shape sync)

> Source: G13 (report 025). The write half of SHACL RDF serialization is **done**
> (report 016 — `serializePathToNodeData` / `syncShapes` emit `sh:path` RDF from a
> `PathExpr`). This is the missing read half.

## The gap

```ts
// DONE (report 016) — write direction:
class Person extends Shape { @objectProperty({path: [knows, name]}) … }  // TS → RDF ✓

// MISSING — read a shape back from RDF and query it:
const shapes = await loadShapesFromDataset(dataset);   // RDF → shape model ✗
Person.select(p => [p.knows.name])   // can't: .path was never reconstructed
```

## What the reader must parse (inverse of `serializePathToNodeData`)

| SHACL RDF (`sh:path` object) | `PathExpr` |
|---|---|
| a plain IRI | `{id}` (a `PathRef`) |
| an `rdf:List` `( a b … )` | `{seq: [...]}` (≥2 members) |
| `[ sh:inversePath P ]` | `{inv: …}` |
| `[ sh:alternativePath ( a b ) ]` | `{alt: [...]}` |
| `[ sh:zeroOrMorePath P ]` | `{zeroOrMore: …}` |
| `[ sh:oneOrMorePath P ]` | `{oneOrMore: …}` |
| `[ sh:zeroOrOnePath P ]` | `{zeroOrOne: …}` |

There is no `sh:path` form for `negatedPropertySet` — SHACL cannot represent it,
so it stays write-unsupported in both directions (see G13, report 025).

## What it unlocks
- SHACL `.ttl` files as the **source of truth** for shapes.
- Shapes shared across languages/services purely as RDF.
- Round-tripping a shape through a triple store without losing its property paths.

## Why it's its own effort
Beyond the path parser, the import side needs: how loaded shapes **register** as
classes (name collisions; datatype/cardinality recovery from `sh:datatype` /
`sh:minCount` / `sh:maxCount`) and where `loadShapesFromDataset` lives. Backend-only
(the reader, like the writer, never ships in the lean frontend `toJSON`/`fromJSON`
path). Pairs with backlog 004/005 (CONSTRUCT / named graphs) for the full RDF-import story.
