---
summary: Add a SHACL→PathExpr reader so shape sync is bidirectional. Today `serializePathToNodeData` writes a `PathExpr` to `sh:path` RDF (TS decorators → RDF), but there is no reverse reader — a shape authored as RDF/Turtle (or stored in the graph) cannot have its property paths reconstructed into `PathExpr`, so its relations are not queryable. G13 (report 021).
packages: [core]
---

# 012 — SHACL `sh:path` → `PathExpr` reader (bidirectional shape sync)

> Source: G13 (report 021, plan 003). Shape sync is currently **one-way**:
> `serializePathToNodeData` (backend, `syncShapes`) writes a `PathExpr` into
> `sh:path` triples. There is **no reader** for the reverse direction. Aligns
> with idea 015 (SHACL RDF serialization).

## The gap

```ts
// TODAY — only the write direction exists:
class Person extends Shape { @objectProperty({path: [knows, name]}) … }  // TS → RDF ✓
serializePathToNodeData({seq: [knows, name]}, base)  //  → sh:path ( ex:knows ex:name )

// MISSING — read a shape back from RDF and query it:
const shapes = await loadShapesFromDataset(dataset);   // RDF → shape model ✗
Person.select(p => [p.knows.name])   // can't: .path was never reconstructed
```

## What a reader must parse (inverse of `serializePathToNodeData`)

| SHACL RDF (`sh:path` object) | `PathExpr` |
|---|---|
| a plain IRI | `{id}` (a `PathRef`) |
| an `rdf:List` `( a b … )` | `{seq: [...]}` (≥2 members) |
| `[ sh:inversePath P ]` | `{inv: …}` |
| `[ sh:alternativePath ( a b ) ]` | `{alt: [...]}` |
| `[ sh:zeroOrMorePath P ]` | `{zeroOrMore: …}` |
| `[ sh:oneOrMorePath P ]` | `{oneOrMore: …}` |
| `[ sh:zeroOrOnePath P ]` | `{zeroOrOne: …}` |

(There is no `sh:path` form for `negatedPropertySet` — SHACL cannot represent it,
so it is write-unsupported in both directions; see G13.)

## What it unlocks
- SHACL files (`.ttl`) as the **source of truth** for shapes.
- Shapes shared across languages/services purely as RDF.
- Round-tripping a shape through a triple store without losing its property paths.

## Why it's its own effort (not a cleanup fix)
Needs design beyond the path parser itself: how loaded shapes **register** as
classes (name collisions, datatype/cardinality recovery from `sh:datatype` /
`sh:minCount` / `sh:maxCount`), and where `loadShapesFromDataset` lives. Backend-only
(the reader, like the writer, never ships in the lean frontend path).

## Scope
- Backend / `syncShapes`-adjacent module only. Keep out of the `toJSON`/`fromJSON` wire path.
- Pairs with idea 015 (serialize the *rest* of the SHACL metadata, not just paths).
