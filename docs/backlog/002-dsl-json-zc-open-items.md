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

- **Projection shorthand:** bare-string leaves (`"name"`) and `{as, value}` computed fields, vs the
  current explicit `{path, as, value, where, ...}` object form (which round-trips correctly).
- **Envelope:** `sortBy` as an ordered array of `{path: dir}`, `singleResult` → `one`, `fields: "*"`
  for `selectAll()`, dropping the deprecated `orderDirection`.
- **Mutation node shorthand:** path-keyed `data: {name: "Alice"}` vs the current `{shape, fields:[…]}`
  envelope (which is self-describing and round-trips correctly).

Each is a wire-shape change with test churn and consumer impact, with no IR-leak benefit; sequence
them as a focused follow-up if the prettier wire is wanted.
