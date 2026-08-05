---
summary: Ideation for `byShape` — a query-time polymorphic projection that reads a shapeless/polymorphic object property (e.g. `sh:path`) differently per value's runtime shape. Focus of ideation — DSL format and result typing/inference over the arms.
status: Ideation
source_backlog: packages/core/docs/backlog/031-byshape-polymorphic-projection.md
related: [029 (query type system refactor), 030 (sh:path → PathExpr reader), 013 (nested builder values — mutation analog)]
---

# 031 — `byShape` polymorphic projection — Ideation

Source backlog: [031](../backlog/031-byshape-polymorphic-projection.md). Shipped in plan-011 T9:
**Option B** — a shapeless IRI-valued object property projects the value's node ref `{id}`.
This item reads the **structure** of polymorphic values by branching on each value's runtime shape.

## Grounding facts (from code exploration)

- **DSL entry**: `Shape.select(p => [...])` → `SelectQuery`; nesting via `QueryShape.select` /
  `QueryShapeSet.select` returning `FieldSet`. Proxy builder in `ProxiedPathBuilder.ts`.
- **Option B fallback**: `SelectQuery.generatePathValue` (packages/core/src/queries/SelectQuery.ts:590-609)
  instantiates a generic base `Shape` for a shapeless object property → `{id}`.
- **Result typing**: `QueryResponseToResultType` → `GetQueryObjectResultType` → `CreateQResult`
  (SelectQuery.ts:255-421) — deeply nested conditional types. 029 refactors these; 031's union
  result type rides along.
- **Runtime shape detection exists**: `Shape.typesToShapes` registry + `getShapeClass()` resolve a
  node's shape from its `rdf:type`. This is what `byShape` dispatches on.
- **`PathNode` shape already exists** (packages/core/src/shapes/PathNode.ts): `inversePath`,
  `alternativePath` (→ `List`), `zeroOrMorePath`, `oneOrMorePath`, `zeroOrOnePath`.
- **`List` shape** (packages/core/src/shapes/List.ts) exposes `first` + `rest` (a linked-list
  spine) — **there is no `members` accessor today**. The backlog's `l.members` does not exist yet.
- **Existing per-value method**: `.as<Shape>()` narrows the *static* type only — no runtime dispatch.
- **`sh:path`** registered shapeless + `contains:true` in Package.ts:633-645.

## Open-item map (decisions) — see chat for options

1. DSL surface/spelling for the projection.
2. Arm list format ([Shape, fn] tuples vs object map vs chained `.on()`).
3. Fallback arm representation.
4. Result type over the arms (discriminated union? optional-field union? tagged?).
5. Whether type inference can survive per-arm projection (the crux).
6. Scalar vs set values (`byShape` on a single value vs a set).
7. `List` structure access — add `members` accessor / flatten, vs raw `first`/`rest`.
8. Dispatch semantics — first-match ordering, no-match behavior, shape subtype handling.
9. Execution strategy — SPARQL UNION vs unconstrained projection + post-hoc decode.
10. Relationship to 030 (build the PathExpr reader on top of `byShape`, or standalone).
11. Relationship to 029 (does 031 need 029 first, or can it land independently).

_Decisions recorded below as accepted._
