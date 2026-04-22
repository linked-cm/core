# Fuseki Nested-Optional Query Fix

## Summary

This report records the `packages/linked` fix for incorrect LINCD-generated SPARQL against Fuseki. The root cause lived in `src/sparql/irToAlgebra.ts`: nested optional traversals were emitted as sibling `OPTIONAL` blocks, which let Fuseki bind child triples independently from the parent traverse.

The fix keeps nested optional traverses structurally nested and resolves shape/property IDs to ontology IRIs before SPARQL emission.

## What Changed

- root shape scans now resolve to `ShapeClass.targetClass.id`
- property references now resolve to `PropertyShape.path`
- nested optional traverses are emitted as nested `OPTIONAL` blocks instead of flattened sibling blocks
- child properties under optional traverses are prevented from escaping into required triple sets

## Key Behavior

LINCD usage such as:

```ts
e.image.select((img) => [img.contentUrl])
```

now produces SPARQL shaped like:

```sparql
OPTIONAL {
  ?event schema:image ?image .
  OPTIONAL {
    ?image schema:contentUrl ?contentUrl .
  }
}
```

instead of:

```sparql
OPTIONAL { ?event schema:image ?image . }
OPTIONAL { ?image schema:contentUrl ?contentUrl . }
```

## Validation

- `cd packages/linked && yarn build`
- cross-repo runtime verification confirmed:
  - active events load correctly again
  - March/April events no longer inherit incorrect images
  - Rotary retains its real image

## Related Work

- `packages/lincd.org/docs/reports/001-fuseki-nested-optional-query-fix.md`
- `packages/the-game/docs/reports/001-fuseki-nested-optional-query-fix.md`

## Wrapup Notes

- no findings were identified for the linked/core implementation
- a changeset is still needed before PR if linked package release notes are required
