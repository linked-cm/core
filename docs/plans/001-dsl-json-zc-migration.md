---
status: Ideation
summary: Migrate the DSL-JSON wire format from the IR-embedding form to the Z-c grammar (documentation/dsl-json.md) — query.toJSON() emits Z-c and fromJSON() reads it — preserving lower(fromJSON(query.toJSON())) ≡ lower(query). Open items in docs/backlog/002-dsl-json-zc-open-items.md.
packages: [core]
---

# 001 — DSL-JSON Z-c migration

## Intent

Replace the current wire format (which embeds raw `IRExpression` in where-clauses and uses
`{kind:…}` value tags in mutations) with the **Z-c grammar** specified in
[documentation/dsl-json.md](../../documentation/dsl-json.md). The builder→IR→store pipeline and
`lower()` are unchanged; only the **middle tier** (the bytes `toJSON()`/`fromJSON()` exchange)
changes. The governing invariant is:

```
lower(fromJSON(query.toJSON())) ≡ lower(query)        // selects
lowerMutationJSON(mutation.toJSON()) ≡ lower(mutation) // mutations
```

The core new component is a **bidirectional Z-c ⇄ `{ir: IRExpression, refs}` codec**: because an
`ExpressionNode` is just `(ir, refs)`, converting Z-c to/from that pair leaves the rest of the
pipeline (lowering, `resolveExpressionRefs`) untouched.

## Planning blockers (decisions)

> Filled during ideation; resolved decisions recorded below. Detailed approaches/pros-cons are
> explored in chat (automatic mode) and condensed here.

- D1 — Encoder strategy: walk `ExpressionNode.ir` (+ `_refs`) → Z-c, or walk the builder WherePath?
- D2 — IRI↔label resolution: how the encoder recovers dotted labels from property-shape IRIs.
- D3 — Path syntax helpers: one dotted-string parser/printer (segments, `fn()`, `as(Shape)`).
- D4 — Two-tier dispatch on decode: object = path-keyed condition; array = S-expr.
- D5 — Mutation value grammar: bare/`{path}`/`{id}`/`{date}`/`{list}`/S-expr + condition-vs-value split.
- D6 — Scope of first cut: which Z-c features land now vs defer (calls/actions → backlog 002).
- D7 — Test strategy: rewrite the two serialization suites to Z-c + a round-trip conformance suite.

## Accepted decisions

> (recorded during ideation)

## Selected route

> (recorded at end of ideation)
