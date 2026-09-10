---
summary: >
  `update().for({id})` against a node that does not exist writes its properties under that id with
  no `rdf:type` — a node no shape-scoped select can find — and reports success. Decide whether that
  should stay, become a no-op, or throw.
status: Backlog
---

# 039 — what should `update` do to an id that does not exist?

## The behaviour

`updateToAlgebra` seeds its WHERE with an empty BGP and wraps every old-value pattern in
`OPTIONAL`. A WHERE made only of OPTIONALs yields one solution even when nothing matches, so:

```sparql
DELETE { <missing> <hobby> ?old_hobby . }
INSERT { <missing> <hobby> "Chess" . }
WHERE  { OPTIONAL { <missing> <hobby> ?old_hobby . } }
```

**inserts.** The node now exists, carries `hobby`, and has no `rdf:type`. Every shape-scoped
select filters on the type triple, so nothing can read it back. The call returns normally.

This is long-standing behaviour, not a regression. It was characterised while building
`Shape.upsert()` (backlog 038, `docs/plans/002-shape-upsert.md`) — upsert is exactly this plan
plus the type triple, which is what made the gap visible.

## Why it matters

It is a silent partial write, and silent partial writes are how the CN incident behind backlog 038
stayed invisible in production. A caller who believes a node exists — or whose existence check was
wrong — does not get an error. They get a half-node, and the failure surfaces much later as "the
record is missing" from the read side.

## The options

1. **Leave it, documented.** Done for now — `Shape.update`'s doc comment and
   `documentation/dsl-json.md` both state it. Cheapest, changes nothing, but keeps a sharp edge.
2. **No-op on an absent node.** Require the type triple in the WHERE (non-optional). Arguably the
   correct reading of "update": it updates a thing that exists. Makes `upsert` the only way to
   create. **Breaking** — every consumer relying, knowingly or not, on the current write-anyway
   behaviour changes silently, and some current writes become no-ops.
3. **Throw.** Needs an existence check, so a second round-trip on every update — the cost
   `upsert` was designed to avoid. Rejected unless it can be made conditional.

Option 2 is the likely answer; the work is in staging it. It wants a deprecation cycle, or at
minimum a survey of consumers, not a quiet flip.

## Trigger

When a consumer is bitten by an untyped node, or when core next takes a breaking-change window.
