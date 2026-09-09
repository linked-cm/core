---
summary: >
  A shape property whose label collides with a `QueryShape` member — `equals`, `as`, `if`,
  `select`, `where`, `id`, `size`, `add`, `concat`, `oneOf`, `none`, `every`, `some` — is
  unreadable through the query DSL. The proxy returns the DSL method, and the field tracer
  fails with "Unknown trace result type: function". The meta-model's own `sh:equals`
  property hits this.
status: Backlog
---

# 041 — property names that collide with the query DSL

## The behaviour

The query proxy resolves a key by checking the `QueryShape` instance first:

```ts
if (key in queryShape) {
  return queryShape[key];
}
// …only then look for a property shape with that label
```

So a property whose label matches a `QueryShape` member never reaches property resolution.
The caller gets the DSL method instead, and `FieldSet.convertTraceResult` throws:

```
Unknown trace result type: function () { [native code] }
```

Colliding names today: `equals`, `as`, `if`, `select`, `selectAll`, `where`, `id`, `size`,
`add`, `concat`, `create`, `every`, `some`, `none`, `oneOf`, `notOneOf`.

## Why it matters

`equals` is not hypothetical — **the SHACL meta-shape itself uses it.** `Package.ts`
registers the `sh:equals` constraint under the label `equals` (while
`PropertyShapeData` calls the field `equalsConstraint`), so
`PropertyShape.select(ps => [ps.equals])` cannot be written. Create Now's shape catalog
hit this the first time it was run against a real store, and had to drop the constraint
from its projection.

More generally: a person modelling a domain is free to name a property `size`, `id` or
`as`. Nothing warns them, and the failure surfaces as an internal tracer error naming a
native function.

## Two problems, one cause

1. **The meta-shape's own label is wrong.** `equals` should be `equalsConstraint`, matching
   the metamodel field. `syncShapes` is the only writer of that key, so the rename is
   contained. This alone makes `sh:equals` readable.
2. **The general collision remains.** Resolution order prefers the DSL surface over the
   user's data, silently. Options: look up property shapes FIRST and fall back to the
   `QueryShape` member; or keep the order and *throw a named error* when a shape declares a
   colliding label, at registration time rather than at query time — the model author can
   then rename it, which is a decision they should be allowed to make knowingly.

Registration-time detection is cheap: the labels are known when the shape is registered.
