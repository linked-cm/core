---
status: Implementation
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

- **D1 — Encode from `ExpressionNode.ir` + `_refs`.** The runtime `WherePath` is only
  `{expressionNode}` | `{existsCondition}`, so the IR tree is the single source of truth. A pure,
  shape-aware codec walks it; no builder-internal threading.
- **D2 — Deterministic IRI↔label.** PropertyShape id = `{shapeId}/{label}` (SHACL.ts:629). Encode a
  label as the segment's `.label` (or last IRI segment); decode a dotted path via `walkPropertyPath`,
  which reconstructs identical segment IRIs — so `lower` of the round-trip is byte-identical.
- **D3 — One path-grammar module.** `segmentsToPath(segmentIds)` → `"a.b.c"` (+ `fn()` / `as(Label)`
  suffixes) and `pathToSegments(shape, path)` → `{segments, trailingCall?, cast?}`, built on
  `walkPropertyPath` for the property hops.
- **D4 — Structural decode dispatch.** array ⇒ S-expr (head = operator symbol or function name);
  object ⇒ a recognized value-object (`{id}`/`{$ctx}`/`{path}`/`{date}`/`{list}`) or a path-keyed
  condition (+ `and`/`or`/`not`, quantifiers); bare scalar ⇒ literal.
- **D5 — Mutation values share the value grammar.** Replace the `{kind:…}` tags with
  bare / `{path}` / `{id}` / `{date}` / `{list}` / setMod / nested-node / S-expr. The old `expr`
  kind becomes an S-expr via the shared expression codec (condition-vs-computed-value split:
  mutation values never use the path-keyed condition form). **`MutationSerialization.ts` is the live
  codec — modified, not deleted.**
- **D6 — Scope.** Implement everything `query-fixtures` exercise. Defer (backlog 002): shape-method
  calls, side-effecting actions, `in`/`nin`, preload special-casing (preload sub-selects keep
  serializing as ordinary sub-selects). Wire version stays `"1.0"`.
- **D7 — Tests.** Rewrite `serialization.test.ts` + `mutation-serialization.test.ts` to the Z-c
  shapes; add `dsl-json-roundtrip.test.ts` asserting `lower(fromJSON(q.toJSON())) ≡ lower(q)` (selects)
  and `lowerMutationJSON(m.toJSON()) ≡ lower(m)` (mutations) across all fixtures.

## Selected route

A new pure codec module **`src/queries/ZcExpression.ts`** (bidirectional IR ⇄ Z-c value/condition +
the path-grammar helpers), then rewrite the four existing serialization seams to use it:

1. `serializeWherePath` / `deserializeWherePath` (`QueryBuilderSerialization.ts`)
2. `FieldSet.toJSON` / `fromJSON` (`FieldSet.ts`) — Z-c projection (bare strings, `{as,value}`,
   relation nesting) + per-path `sortBy` array
3. the mutation value codec (`MutationSerialization.ts`) — Z-c value grammar
4. the select envelope (`QueryBuilder.ts`) — `sortBy` ordered array, `singleResult`→`one`, `fields:"*"`

plus reserve `and`/`or`/`not` as property labels at shape registration. The IR pipeline, `lower()`,
and `resolveExpressionRefs` are untouched — round-trip-through-`lower` is the gate.

## Plan

### Architecture

One new pure module, **`src/queries/ZcExpression.ts`**, is the codec. Everything else delegates to
it. It depends only on IR types, `ExpressionNode`/`ExistsCondition`, `walkPropertyPath`, and the
shape registry — no builder internals.

```
toJSON path:   builder → {ir,refs}/{existsCondition} ──ZcExpression.encode──▶ Z-c JSON
fromJSON path: Z-c JSON ──ZcExpression.decode──▶ {ir,refs}/{existsCondition} → builder → lower()
```

### Contracts — `ZcExpression.ts`

Wire types:

```ts
type ZcScalar = string | number | boolean;
type ZcRef    = { id: string };
type ZcCtx    = { $ctx: string; path?: string };
type ZcDate   = { date: string };
type ZcList   = { list: ZcValue[] };
type ZcPath   = { path: string };                 // a property/computed-path used as a VALUE
type ZcSExpr  = [string, ...ZcValue[]];           // head = operator symbol | function name
type ZcValue  = ZcScalar | ZcRef | ZcCtx | ZcDate | ZcList | ZcPath | ZcSExpr;

type ZcOpMap     = { [op: string]: ZcValue | ZcList };   // { ">": 18 }, { "in": {list} }
type ZcCondition =
  | { [path: string]: ZcValue | ZcOpMap }   // path-keyed (implicit equals / operator map / quantifier)
  | { and: ZcCondition[] } | { or: ZcCondition[] } | { not: ZcCondition }
  | ZcSExpr;                                  // S-expr fallback (evaluates to boolean)
```

Functions (pure; all take the shape context they resolve labels against):

```ts
// VALUE tier (computed values, S-expr operands)
encodeValueExpr(ir: IRExpression, refs: PropertyRefMap, shape: NodeShape): ZcValue
decodeValueExpr(zc: ZcValue, shape: NodeShape): { ir: IRExpression; refs: PropertyRefMap }

// CONDITION tier (where clauses → boolean)
encodeCondition(node: ExpressionNode | ExistsCondition, shape: NodeShape): ZcCondition
decodeCondition(zc: ZcCondition, shape: NodeShape): WherePath   // {expressionNode}|{existsCondition}

// PATH grammar
segmentsToPath(segmentIds: readonly string[], shape: NodeShape, trailing?: {call?: string}): string
pathToSegments(shape: NodeShape, path: string): { segmentIds: string[]; call?: string; castLabel?: string }
```

Encoder canonical form (decoder accepts the full grammar): implicit-equals for `=`, implicit-AND
(multi-key) when conjuncts are distinct-path path-keyed conditions else `{and:[…]}`, path-keyed
comparisons when the LHS is a single property/alias/context-property, S-expr otherwise.

### IR ⇄ Z-c mapping table

| IR node | Z-c (value tier) | Z-c (condition tier) |
|---|---|---|
| `literal_expr` | bare scalar / `{date}` | — |
| `reference_expr {value}` | `{id}` | — |
| `reference_expr {contextName}` | `{$ctx}` | — |
| `context_property_expr {contextName,property}` | `{$ctx, path}` | — |
| `property_expr` | `{path}` | path **key** |
| `alias_expr` (node) | `{id}` target side; path key on the relation | path **key** (relation) |
| `binary_expr` (`=`,`!=`,`<`,`>`,`+`,…) | `[op, …]` | `{ key: {op: val} }` or `{key: val}` |
| `logical_expr` and/or | `[and/or, …]` | `{and/or: […]}` or multi-key |
| `not_expr` | `[not, …]` | `{not: …}` |
| `function_expr {name:UPPER}` | `[lowerName, …]` / path `fn()` | path key `fn()` |
| `aggregate_expr {name:count}` | `[size, …]` / path `size()` | path key `size()` |
| `ExistsCondition {some/none}` | — | `{ "rel.some"/"rel.none": pred }` |

### Expected file changes

| File | Change |
|---|---|
| `src/queries/ZcExpression.ts` | **NEW** — the codec + path helpers + wire types. |
| `src/queries/QueryBuilderSerialization.ts` | Rewrite `serializeWherePath`/`deserializeWherePath` to delegate; replace `WherePathJSON`/`ExistsConditionJSON` with `ZcCondition`; `serializeSortByPath`→ordered array; keep `RawMinusEntry` (where via the new codec). |
| `src/queries/FieldSet.ts` | `toJSON`/`fromJSON` → Z-c projection: bare-string leaves, `{path:{as,where,one,fields,cast}}`, `{as,value}` for `expressionNode`/`customKey`/aggregate; preserve innerLimit/offset/orderBy as field options. |
| `src/queries/MutationSerialization.ts` | Rewrite `encodeValue`/`encodeSingleValue`/`decodeValueToRaw` + `MutationValueJSON` to the Z-c value grammar (computed → S-expr via codec). |
| `src/queries/lowerMutationJSON.ts` | `decodeValue` → Z-c value grammar (mirror of the above on the lowering path). |
| `src/queries/QueryBuilder.ts` | Envelope: `sortBy` ordered array, `singleResult`→`one`, `fields:"*"` for selectAll, drop `orderDirection`. |
| `src/queries/wireVersion.ts` | unchanged (`"1.0"`). |
| `src/shapes/SHACL.ts` (registration) | reject `and`/`or`/`not` as property labels. |
| `src/tests/serialization.test.ts` | rewrite assertions to Z-c. |
| `src/tests/mutation-serialization.test.ts` | rewrite assertions to Z-c. |
| `src/tests/dsl-json-roundtrip.test.ts` | **NEW** — `lower(fromJSON(toJSON))≡lower` across all fixtures. |

### Pitfalls

- **P1 — `.some/.every/.none` builder shapes.** Must read how each constructs `ExistsCondition`
  (the `negated` flag, and how `every` is encoded — likely NOT-EXISTS-of-negated) before mapping
  to `some/every/none`. Verify against `whereSome*`/`whereEvery`/`whereNone` fixtures.
- **P2 — `alias_expr` vs `property_expr` on decode.** A path whose final segment is a *relation*
  (object property) lowers to `alias_expr` (node comparison); a *literal* property → `property_expr`.
  Dispatch on the resolved PropertyShape's value kind.
- **P3 — Function/aggregate naming.** IR is uppercase (`STRLEN`) and aggregate is `count`; Z-c uses
  the DSL spelling (`strlen`, `size()`). Keep a finite bidirectional name map.
- **P4 — Implicit-AND key collisions.** Same path twice ⇒ fall back to explicit `{and:[…]}`.
- **P5 — Context refs carry the NAME.** Encode `contextName` (unresolved), never `contextIri`;
  resolution stays at `lower`.
- **P6 — `maxCount`/`pathExpr` on `property_expr`.** Recovered from the shape on decode — do not
  wire them; assert round-trip still produces them.
- **P7 — Tests assert exact OLD JSON.** Rewriting the two suites is mechanical but large; the
  round-trip-through-`lower` suite is the authoritative gate and is written first.

### Validation gate (every phase)

`npx tsc -p tsconfig-cjs.json --noEmit` && `tsc -p tsconfig-esm.json --noEmit` green, and
`npx jest --config jest.config.js --runInBand` with no regressions; the round-trip suite green once
it exists.

## Tasks

Each phase keeps the **round-trip conformance suite green** (the invariant), plus `tsc` clean and
no full-suite regressions. The phase order keeps the build green throughout.

### Phase 1 — Round-trip conformance harness (the gate) — status: done
_Validated: passes on current code — 110 passed, 18 excluded (pre-migration projection gaps + preload), 0 failed._
Write `src/tests/dsl-json-roundtrip.test.ts`: for every select fixture assert
`lower(fromJSON(q.toJSON()))` deep-equals `lower(q)`; for every mutation fixture assert
`lowerMutationJSON(m.toJSON())` deep-equals `lower(m)`. Format-agnostic — it only checks semantic
equivalence, so it passes on the **current** code and guards every later phase.
- **Validation:** suite passes on the current (pre-migration) code.

### Phase 2 — `ZcExpression.ts` codec — status: done
_Validated: tsc cjs+esm clean; zc-expression.test.ts 12/12 pass; full suite 1320 passed (no regressions); codec not yet wired._
Implement the module per the Contracts section: `encodeValueExpr`/`decodeValueExpr`,
`encodeCondition`/`decodeCondition`, `segmentsToPath`/`pathToSegments`, the name maps (P3), the
`alias_expr` vs `property_expr` decode dispatch (P2), context refs carry the name (P5). First read
how `.some/.every/.none` build `ExistsCondition` (P1) and encode the quantifier accordingly. Add a
focused unit test `src/tests/zc-expression.test.ts` over representative IR trees.
- **Validation:** `tsc` (cjs+esm) green; the unit test passes; not yet wired into serialization.

### Phase 3 — Where-clause seam — status: done
_Validated: gate green (110); full suite 1321 passed; tsc cjs+esm clean. serialize/deserializeWherePath delegate to the codec; legacy evaluation/andOr/QueryStep machinery removed; where-format test assertions rewritten to Z-c. Fixed alias_expr-vs-property_expr rule: empty path = subject (alias), non-empty = property._
Rewrite `serializeWherePath`/`deserializeWherePath` (`QueryBuilderSerialization.ts`) to delegate to
the codec; replace `WherePathJSON`/`ExistsConditionJSON` with `ZcCondition`. Update `RawMinusEntry`
(its `where`). Update the where-related assertions in `serialization.test.ts`.
- **Validation:** round-trip suite green; full suite green; `tsc` green.
- **Depends on:** Phase 2.

### Phase 4 — Projection (computed + scoped filters) — status: done (partial)
_Validated: gate 123 passed (was 110); full suite 1338 passed; tsc cjs+esm clean. FieldSet.toJSON/fromJSON now serialize computed projections (expressionNode -> Z-c {value}) and scoped relation filters (-> {where, whereIndex}) via the codec, completing their round-trip. DEFERRED to backlog 002: `.as(Shape)` projection casts (need a cast wire form) and the envelope/projection COSMETIC reshape (sortBy ordered array, singleResult->one, fields:"*", bare-string/{as,value} projection shorthand) — none of which are IR leaks._
`FieldSet.toJSON`/`fromJSON` → Z-c projection (bare-string leaves, `{path:{as,where,one,fields,cast}}`,
`{as,value}` for computed/customKey/aggregate, preserve inner limit/offset/orderBy). `serializeSortByPath`
→ ordered array of `{path: dir}`. `QueryBuilder` envelope: `singleResult`→`one`, `fields:"*"` for
selectAll, drop `orderDirection`. Update projection/sort assertions in `serialization.test.ts`.
- **Validation:** round-trip suite green; full suite green; `tsc` green.
- **Depends on:** Phase 2 (computed-field values use the codec).

### Phase 5 — Mutation value grammar — status: done
_Validated: gate green (110); full suite 1321 passed; tsc cjs+esm clean. Mutation values now use the Z-c grammar (bare/{id}/{date}/{$ctx}/{list}/{node}/setMod/S-expr); the `expr` IR leak is gone (computed values are S-exprs via the codec). The {shape,fields} node envelope is kept (decodable, non-leaking); path-keyed node reshape deferred (cosmetic). ctxRef assertions updated to {$ctx}._
Rewrite `encodeValue`/`encodeSingleValue`/`decodeValueToRaw` + `MutationValueJSON`
(`MutationSerialization.ts`) and `decodeValue` (`lowerMutationJSON.ts`) to the Z-c value grammar;
computed (`expr`) → S-expr via the codec. Rewrite `mutation-serialization.test.ts` assertions.
- **Validation:** round-trip suite green; full suite green; `tsc` green.
- **Depends on:** Phase 2. Independent of Phases 3–4 (different files).

### Phase 6 — Reserve `and`/`or`/`not` labels — status: done
_Validated: reserved-labels.test.ts 4/4 pass; full suite 1325 passed (no existing shape uses the reserved labels)._
Reject those three as property labels at shape registration (`SHACL.ts`). Add a test asserting it
throws.
- **Validation:** new test passes; full suite green.
- **Depends on:** none (independent).

### Phase 7 — Finalize test suites + full validation — status: pending
Finish rewriting `serialization.test.ts` and `mutation-serialization.test.ts` to the exact Z-c
shapes (any assertions not already updated). Full `tsc` (cjs+esm) + `jest` run; confirm the Fuseki
suite still compiles (it self-skips without Docker).
- **Validation:** entire suite green; `tsc` green; doc updated; review-ready.
- **Depends on:** Phases 3–6.

### Dependency graph

```
P1 (gate) ─┐
P2 (codec)─┼─▶ P3 (where) ─┐
           ├─▶ P4 (proj)  ─┼─▶ P7 (finalize)
           └─▶ P5 (mut)   ─┘
P6 (labels) ──────────────┘   (independent)
```

P3/P4 share select files → sequential. P5 is file-disjoint from P3/P4 (could run alongside, but the
shared codec is settled in P2, so order is not critical). P6 is fully independent.
