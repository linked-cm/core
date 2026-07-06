---
summary: Support computed/expression AND subquery-derived values in `create` by lowering to `INSERT … WHERE` when any value is non-ground, instead of the current `INSERT DATA`-only path. G4 (report 024) currently throws for such values; this is the feature that would make them work.
packages: [core]
---

# 011 — Create with computed / subquery-derived values

> Source: raised while fixing G4 (report 024). G4 makes `create`
> **throw** for a computed/expression value because `create` lowers only to
> `INSERT DATA` (ground triples, no `WHERE`). This backlog captures the feature
> that would make those values *work* rather than error.

## The use cases
```ts
Person.create({ name: 'joe', createdAt: Expr.now() })                 // computed value
Person.create({ name: 'joe', place: Region.select(r => r.default) })  // subquery-derived value
```
Both are expressible in SPARQL via `INSERT … WHERE`:
```sparql
INSERT { <joe> :name "joe" ; :createdAt ?now }
WHERE  { BIND(NOW() AS ?now) }

INSERT { <joe> :name "joe" ; :place ?place }
WHERE  { <subquery deriving ?place> }
```

## Design sketch
- `createToAlgebra` detects whether **all** field values are ground literals/refs
  (→ keep the fast `INSERT DATA` path) or **any** is an `IRExpression` /
  subquery (→ emit `INSERT { template } WHERE { … }`).
- Ground fields go into the INSERT template; computed fields BIND in the WHERE;
  subquery-derived fields become a correlated sub-SELECT in the WHERE (shares
  machinery with membership Rung 2, backlog 010).
- The generated subject id binds via `BIND(<new-iri> AS ?subject)`.

## Relationship to current behavior
Until this lands, G4's loud throw is the correct interim: it prevents the old
silent data-loss. When this ships, remove the throw for the computed/subquery
case (keep it only for genuinely unrepresentable values, if any).

## Open questions
- Multi-subject create with derived values (fan-out) semantics.
- Interaction with `nullSubject` / conditional create.
- Whether to expose it implicitly (any expression value triggers INSERT…WHERE)
  or via an explicit `.createFrom(query)` surface.
