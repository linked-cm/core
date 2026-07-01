---
summary: Deferred, non-blocking design items for the DSL-JSON Z-c wire grammar (documentation/dsl-json.md). The grammar is settled and the hard-press findings are folded in; these are the remaining open questions that do not block the format or its migration.
packages: [core]
---

# 002 — DSL-JSON (Z-c) open items

The [DSL-JSON spec](../../documentation/dsl-json.md) is settled for `v:"1.0"` and the six
hard-press findings (sortBy array, reserved combinators, `one` naming, `selectAll` `"*"`,
`in`/`nin` list wrapping, mid-path cast in conditions) are folded in. The items below surfaced
during the design press but are **non-blocking** — the format stands without them.

## G1 — `preload` hints

`QueryBuilder.preload(...)` / `.preloadFor(component)` have no wire representation yet. Preload is
a fetch-strategy *hint*, not query semantics, so it is arguably out of the wire's core scope.
- **Likely shape:** a field option — `{ "friends": { "preload": <component-ref> } }` — or omitted
  entirely (treated as a runtime-only concern that does not cross the wire).
- **Open:** whether a preload target (a component / FieldSet) is even serializable across a boundary.

## G2 — `{$ctx}` through a plural relation

`{ "$ctx": "user", "path": "friends.name" }` resolves to a **set** of values. As a condition value
this is an implicit membership test (`in`-like), but the semantics aren't pinned.
- **Likely shape:** when a `{$ctx}` operand resolves to a set, an `=` against it means `in`.
- **Open:** confirm at lowering time; decide whether to require an explicit `in` instead.

## G3 — Side-effecting shape methods (the action envelope)

The expression grammar admits only **pure, value-producing** shape methods. Side-effecting
methods (`sendEmail`, `archive`, …) are deferred to a future **top-level action envelope** that
reuses the same call node:

```jsonc
// FUTURE — not in v1.0
{ "v":"1.0", "op":"call", "shape":"Person", "target": { "$ctx":"user" },
  "call": { "call":"sendEmail", "args":[ "Welcome", "Hello there" ] } }
```

- **Decided principle:** *position* (a `where`/value slot vs. an action slot) gates pure-vs-action,
  not syntax — so the where-clause call form will not change when actions land.
- **Open:** the action envelope's own concerns — target/subject resolution, return values,
  permissions/auth, idempotency, batching. These are substantial and out of scope until a concrete
  need exists.

## G4 — Pure-vs-side-effect method registry

For G3's guardrail (a side-effecting method rejected in expression position) the shape must declare
each method's purity.
- **Likely shape:** a `pure: boolean` flag on the shape-method registration; the expression decoder
  resolves a `{call}` in expression position only when the method is registered pure.
- **Open:** where method purity is declared (decorator metadata?) and how it travels (it doesn't need
  to be on the wire — it's resolved against the registered shape on the receiving side).

## G5 — `.as(Shape)` projection casts

`Person.select(p => p.pets.as(Dog).guardDogLevel)` does not round-trip: the cast (a mid-path type
narrowing) is not yet carried on the wire, so the dotted path `pets.guardDogLevel` can't be
re-walked (the leaf is on the subclass). Needs a cast segment on the projection field (e.g.
`{ "path": "pets", "cast": "Dog", "fields": [...] }` per the spec) and the matching FieldSet
(de)serialization. Two fixtures excluded from the round-trip gate: `selectShapeAs`,
`selectShapeSetAs`.

## G6 — Cosmetic wire reshape (non-functional)

The migration eliminated the IR leak (where-clauses + mutation values). These remaining items are
**cosmetic** — they change the wire's shape, not its IR-freeness, and are deferred:

**Shipped** (plan 001, iteration 1): bare-string projection leaves; `sortBy` ordered array;
`singleResult` → `one`; dropped `orderDirection`. (`fields:"*"` skipped — `selectAll()` already
round-trips as enumerated fields.)

**Remaining** (the one deferred G6 piece):
- **Mutation node shorthand:** path-keyed `data: {name: "Alice"}` vs the current `{shape, fields:[…]}`
  envelope. Deferred as the highest-risk / lowest-value reshape (mutation data is machine-generated;
  the current form is IR-free and round-trips). Doing it needs nested-node shape threading (a nested
  node's shape derived from the parent property's value-shape) across encode/decode/builders/lowering.

## G7 — DSL-JSON test-coverage review: gaps & edge limitations

From a full review of the DSL-JSON test suite (round-trip gate + explicit-shape suites). The gate
proves **semantic** (lower-)equivalence across 125 fixtures; the items below are edges the gate
doesn't reach. Closed ones were added during the review.

**Closed during review** (tests added):
- Quantifier wire shapes (`{"friends.some":…}`, `.none`, `.every`) — `zc-expression.test.ts`.
- S-expr fallback wire shape (function-LHS comparison, chained arithmetic) — `zc-expression.test.ts`.
- `fromJSON` rejects an unrecognized `op` — `mutation-serialization.test.ts`.
- Path-keyed mutation node + `__id` + `__shape` polymorphism — `dsl-json-mutation-node.test.ts`.

**Open edge limitations** (low-risk, no fixtures hit them):
- **`in` / `nin` half-wired.** The condition decoder recognizes `in`/`nin` as operators, but there
  is no IR operator, no encoder path, and `{list}` decoding throws. Effectively unsupported —
  either wire it end-to-end (IR operator + SPARQL) or drop it from the recognized-operator set.
- **Reserved value-key collision in mutation node data.** A property literally named `id`, `list`,
  `date`, `path`, `$ctx`, `add`, `remove`, or `unset` would be mis-read as a tagged value rather
  than a property (a bare nested node is detected by *absence* of these keys). Analogous to the
  `and/or/not` condition-key reservation but not currently guarded for mutation-value positions.
- **Cross-shape context property.** `{$ctx, path}` resolves the `path` against the *query* root
  shape, not the context entity's own shape — correct when they coincide (the only case fixtures
  exercise). A context property on a different shape would need the context shape on the wire.
- **Nested `some`-of-`some`** is rejected by the *builder* (not a DSL construct), so the codec never
  sees it — noted so it isn't mistaken for a codec gap.
