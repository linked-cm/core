---
summary: Deferred duplication refactors from the cleanup pass (report 022) that were judged too risky for a "keep-tests-passing" gate — the two DSL-JSON decoders and the two lowering entry points share structure but diverge subtly, so unifying them needs added round-trip fixtures first.
packages: [core]
---

# 007 — DSL-JSON decoder & lowering unification

> Source: deferred from report 022 (simplification & leanness), Gap 3. The safe
> parts of Gap 3 (builder thenable base, `buildPredicateTerm`) were done; these
> two remain.

## What we can do vs. want to do

### A. Unify the two DSL-JSON value decoders
`lowerMutationJSON.decodeValue`/`decodeNodeData` (~74 lines) and
`MutationSerialization.decodeValueToRaw`/`decodeNodeDataToRaw` (~67 lines) walk
the **same** tag grammar (`Array`/`null`/scalar/`unset`/`date`/`$ctx`/`id`/
`list`/`add`+`remove`/`path`/nested-node) but emit different shapes and diverge
on three axes:

| Branch | lowering | rehydration |
|---|---|---|
| `$ctx` | resolves to concrete `{id}` (throws if unset) | preserves `PendingQueryContext` |
| `add`/`remove` | normalized `$add`/`$remove` | raw `add`/`remove` |
| nested node | `{shape, fields:[{prop,val}]}` | plain `Record` |
| unknown key | throws | passes `prop: undefined` |

**Estimated gain:** ~45–55 duplicated lines removed, but ~20–30 lines of adapter
scaffolding added → **net ~25–35 lines**, at some readability cost (two linear
decoders → one callback-parameterized walker). Real value is drift-safety: a new
wire tag is added once instead of twice.

### B. Merge the two lowering entry points
`lower.ts` (~99–142) and `lowerMutationJSON.ts` (~157–210) are ~80% parallel
dispatch onto the same six `buildCanonical*MutationIR` builders, each with its
own `lowerWherePath` and `$ctx` handling.

## Open questions / blockers
- Both are on the `fromJSON` inbound boundary; a subtle behavior change is a wire
  regression. **Prerequisite:** broaden the round-trip fixture matrix (esp.
  `$ctx` policy, `{list}`, unknown-key handling) before refactoring, so the
  unified walker is proven equivalent.
- Decide whether the net line saving justifies the abstraction, or whether this
  is better left as two clear decoders with a shared documented tag list.

## Recommendation
Low priority. Only pursue if several new wire tags are imminent (then drift-safety
pays off). Gate behind expanded round-trip tests.
