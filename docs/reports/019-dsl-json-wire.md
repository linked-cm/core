---
summary: Migrated the DSL-JSON wire format to the compact, IR-free wire grammar — query.toJSON() emits path-keyed conditions, dotted-string projections, an S-expr fallback, and path-keyed mutation node data (with __id/__shape), and fromJSON() rehydrates losslessly. A new pure DslExpression codec bridges the expression IR and the wire; the builder→IR→store pipeline and lower() are unchanged. Round-trip-through-lower is the contract.
packages: [core]
---

# 019 — DSL-JSON wire format

## Outcome

The DSL-JSON wire format ([documentation/dsl-json.md](../../documentation/dsl-json.md)) was migrated
from the IR-embedding form (raw `IRExpression` in where-clauses, `{kind:…}` value tags and a
`{shape,fields}` scaffold in mutations) to the compact wire grammar — compact, DSL-shaped, and **IR-free**.
`query.toJSON()` now emits DSL-JSON and `fromJSON()` reads it back, preserving:

```
lower(fromJSON(query.toJSON())) ≡ lower(query)          // selects
lowerMutationJSON(mutation.toJSON()) ≡ lower(mutation)  // mutations
```

Only the **middle tier** (the bytes exchanged) changed; the builder→IR→store pipeline, `lower()`, and
`resolveExpressionRefs` are untouched. Final state: `tsc` (cjs+esm) clean; full suite **1351 passed**,
0 failed; round-trip conformance gate **125/128** (3 `preload` fixtures deferred).

## Architecture

A single new pure module, **`src/queries/DslExpression.ts`**, is the codec. Everything else delegates
to it. It depends only on IR types, `ExpressionNode`/`ExistsCondition`, `walkPropertyPath`, and the
shape registry — no builder internals.

```
toJSON:   builder → {ir,refs}/{existsCondition} ──DslExpression.encode──▶ DSL-JSON JSON
fromJSON: DSL-JSON JSON ──DslExpression.decode──▶ {ir,refs}/{existsCondition} → builder → lower()
```

The insight that made this tractable: a runtime `WherePath` is only `{expressionNode}` |
`{existsCondition}`, and an `ExpressionNode` is just `(ir, refs)`. Converting DSL-JSON ⇄ that pair leaves
the rest of the pipeline alone. Property labels resolve deterministically because a PropertyShape id
is `{shapeId}/{label}` — encode takes the last segment; decode re-walks via `walkPropertyPath`, which
reconstructs identical segment IRIs, so `lower` of the round-trip is byte-identical.

## Key design decisions

- **D1 — Encode from `ExpressionNode.ir` + `_refs`.** The IR tree is the single runtime source of
  truth; the codec walks it, no builder-internal threading.
- **D2 — Deterministic IRI↔label** via the `{shapeId}/{label}` convention.
- **D3 — Two-tier expression grammar.** A **condition tier** (path-keyed objects: implicit equals,
  operator maps, implicit AND, `and`/`or`/`not`, `some`/`every`/`none` quantifiers) for boolean
  where-clauses, and an **S-expr array tier** (`["op", …]`, head = operator symbol or verbatim IR
  function name) for anything a path-keyed shape can't express (function-LHS comparisons, chained
  arithmetic). The two never collide (object vs array).
- **D4 — Structural decode dispatch.** array ⇒ S-expr; object ⇒ a recognized value-object
  (`{id}`/`{$ctx}`/`{path}`/`{date}`/`{list}`) or a path-keyed condition; bare scalar ⇒ literal.
- **D5 — One value grammar** shared by where-operands and mutation values; the old mutation `expr`
  kind (the last IR leak) became an S-expr.
- **`alias_expr` vs `property_expr`** on decode: an **empty** path is the bare subject
  (`p.equals(x)` → `alias_expr`); any **non-empty** path is a property access (`p.bestFriend.equals(x)`
  compares the property value → `property_expr`, no traversal).
- **Quantifiers:** `some` → `ExistsCondition(negated:false)`; `none` → `(negated:true)`; `every` was
  built as `NOT EXISTS(NOT pred)` so it round-trips as `(negated:true)` with a `not_expr` predicate.
  Chained `and`/`or` on an exists fold into nested logical combinators.
- **Verbatim function/aggregate names** (`STRLEN`, `count`) — no name map, lossless.
- **Context refs carry the name** (`{$ctx}` / `{$ctx,path}`), resolved at `lower`, never baked.
- **Casts inline** (iteration 1): `.as(Shape)` narrowing rides in the dotted path as
  `as(<ShapeLabel>)` segments (`"pets.as(Dog).guardDogLevel"`), detected on encode when a segment's
  owner shape differs from the prior segment's `valueShape`, and resolved on decode by a cast-aware
  walker.
- **Path-keyed mutation node data** (iteration 1): `data: {name:"Alice", bestFriend:{name:"Bestie"}}`
  with reserved `__id` (fixed id) and `__shape` — the latter emitted **only** when a nested node's
  concrete shape differs from the relation's declared value-shape (the polymorphism hatch: a subclass
  instance under a superclass-typed relation). Sets keep `{list}` (a bare array is ambiguous with an
  S-expr). Nested nodes are bare path-keyed objects, disambiguated from tagged values by the property
  kind / absence of a reserved value-key.
- **Envelope** (iteration 1): `sortBy` → ordered array of `{path: dir}` (element order = precedence,
  fixing a JSON key-order hazard); `.one()` → `one` (was `singleResult`); dropped the write-only
  `orderDirection`.
- **Reserved labels:** `and`/`or`/`not` may not be property labels (boolean combinators with no
  key-position escape) — enforced at shape registration.

## IR ⇄ DSL-JSON mapping

| IR node | DSL-JSON value tier | DSL-JSON condition tier |
|---|---|---|
| `literal_expr` | bare scalar / `{date}` | — |
| `reference_expr {value}` / `{contextName}` | `{id}` / `{$ctx}` | — |
| `context_property_expr` | `{$ctx, path}` | — |
| `property_expr` | `{path}` | path **key** (non-empty) |
| `alias_expr` (bare subject) | — | path **key** (empty `""`) |
| `binary_expr` (`=`,`!=`,`<`,`>`,`+`,…) | `[op, …]` | `{key: {op: val}}` or `{key: val}` |
| `logical_expr` and/or | `[and/or, …]` | `{and/or: […]}` or multi-key |
| `not_expr` | `[not, …]` | `{not: …}` |
| `function_expr` / `aggregate_expr` | `[NAME, …]` | path key `fn()` / S-expr |
| `ExistsCondition` some/none/every | — | `{ "rel.some"/"rel.none"/"rel.every": pred }` |

## File structure

| File | Responsibility |
|---|---|
| `src/queries/DslExpression.ts` | **NEW** — the codec: `encode/decodeValueExpr`, `encode/decodeCondition`, path helpers (`segmentsToPath`, `pathToSegmentIds`), the wire types (`DslValue`, `DslCondition`, …). |
| `src/queries/QueryBuilderSerialization.ts` | `serialize/deserializeWherePath` delegate to the codec; `WherePathJSON = DslCondition`; `sortBy` ordered array; minus. Legacy evaluation/andOr/QueryStep machinery removed. |
| `src/queries/FieldSet.ts` | Projection (de)serialization: bare-string leaves, `{as,value}` computed fields, scoped relation filters, and cast-aware paths (`pathToStringWithCasts` / `walkPathWithCasts`). |
| `src/queries/MutationSerialization.ts` | DSL-JSON value grammar + path-keyed node codec (`encodeNodeData`/`decodeNodeDataToRaw`, `valueShapeOf`, `__id`/`__shape`). |
| `src/queries/lowerMutationJSON.ts` | JSON→IR mirror of the mutation value/node codec. |
| `src/queries/QueryBuilder.ts` | Envelope: `sortBy` array, `singleResult`→`one`, dropped `orderDirection`. |
| `src/queries/{Create,Update,Delete}Builder.ts` | `toJSON`/`fromJSON` thread the shape into the node codec. |
| `src/shapes/SHACL.ts` | Reserves `and`/`or`/`not` as property labels. |

## Public API / wire grammar

`query.toJSON()` / `fromJSON(json)` are unchanged in signature; their **payload** is now DSL-JSON. The
exported types `MutationValueJSON` and `MutationNodeDataJSON` changed shape. Representative wire:

```jsonc
// select
{ "v":"1.0", "shape":"…/Person", "fields":["name", {"friends":["name","hobby"]}],
  "where": { "name":"Alice", "friends.some": { "name":"Moa" } },
  "sortBy": [ {"name":"DESC"} ], "one": true }

// create
{ "v":"1.0", "op":"create", "shape":"…/Person",
  "data": { "name":"Alice", "bestFriend": {"name":"Bestie"}, "friends": {"list":[{"id":"…"}]} } }
```

## Test coverage

| Test file | Covers |
|---|---|
| `src/tests/dsl-json-roundtrip.test.ts` | The conformance **gate**: `lower(fromJSON(toJSON))≡lower` over all query fixtures (125 pass; 3 `preload` skipped). Wire-shape-agnostic — the authoritative semantic guard. |
| `src/tests/dsl-expression.test.ts` | Codec units: path helpers, value tier, condition tier, quantifier wire shapes, S-expr fallback shapes (~19). |
| `src/tests/serialization.test.ts` | Select envelope + FieldSet + where explicit shapes (DSL-JSON). |
| `src/tests/mutation-serialization.test.ts` | Mutation round-trip, context resolution/throw parity, wire-version + unknown-op rejection. |
| `src/tests/dsl-json-mutation-node.test.ts` | Path-keyed node form, `__id`, and `__shape` polymorphism round-trip (5). |
| `src/tests/reserved-labels.test.ts` | `and`/`or`/`not` rejected at registration. |
| `src/tests/field-set.test.ts` | FieldSet serialization (updated to bare-string leaves). |

## Known limitations / deferred work

Tracked in [docs/backlog/002-dsl-json-open-items.md](../backlog/002-dsl-json-open-items.md):

- **G1 — `preload` hints** have no wire form (3 fixtures excluded from the gate).
- **G7 edge limitations:** `in`/`nin` is half-wired (recognized by the decoder but no IR operator /
  encoder path — effectively unsupported); a mutation property literally named a reserved value-key
  (`id`/`list`/`date`/`path`/`$ctx`/`add`/`remove`/`unset`) would be mis-read as a tagged value; a
  `{$ctx,path}` context property resolves against the query root shape, not the context entity's own
  shape. None are reached by any fixture.
- **G2–G4** (future scope): shape-method calls, side-effecting actions, method purity registry,
  `{$ctx}` through a plural relation.

## References

- [documentation/dsl-json.md](../../documentation/dsl-json.md) — the wire spec (the contract).
- [documentation/intermediate-representation.md](../../documentation/intermediate-representation.md) —
  the IR (unchanged; now an internal lowering target reached only via `lower()`).
