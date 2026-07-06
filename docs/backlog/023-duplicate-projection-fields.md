# 023 — Duplicate Projection Fields

## Problem

When a user selects the same field twice in a projection, the query builds
successfully but result mapping throws:

```
Duplicate result key "messages" in projection.
Two properties with the same local name cannot appear in the same projection.
```

Example trigger:

```ts
Conversation.select(s => [
  s.title,
  s.messages,
  s.topics,
  s.messages,   // duplicate
])
```

The error is thrown in `resultMapping.ts` (`buildNestingDescriptor`) — late in
the pipeline. Two scenarios need different handling:

### Scenario A — Exact duplicate (same property, same path, no sub-selections)

`s.messages, s.messages` — identical construct. The user just made a typo.

**Proposed behaviour:** Deduplicate silently during `lowerSelectQuery` in
`IRLower.ts`. When a seed resolves to a key that has already been seen *and*
the path is structurally identical, skip the duplicate. No second variable in
the SPARQL output.

### Scenario B — Same local name, different path or sub-selections

```ts
s.messages,                    // bare
s.messages.select(m => m.text) // with sub-selection
```

Or two different properties that happen to share a local name (less likely with
shapes, but possible with raw property paths or renamed keys).

**Proposed behaviour:** Keep both in the projection but auto-suffix the result
key for the second occurrence (`messages`, `messages2`, etc.) — similar to how
SQL aliases work. The `resultMap` entry would carry the suffixed key so result
mapping can distinguish them. Emit a dev-mode warning so the user knows the
rename happened and can assign an explicit key if they prefer.

This may require a `resultKey` / `keyNameInResult` field on `IRResultMapEntry`
if one doesn't already exist (check `key` vs `alias` semantics — `alias` is
the SPARQL variable name, `key` is the JS result key; the suffixed name would
go into `key`).

## Where to implement

1. **Dedup (Scenario A):** `IRLower.ts` → `lowerSelectQuery`, after
   `projectionSeeds` is built. Compare by key + structural path equality.
2. **Rename (Scenario B):** Same location, but instead of skipping, mutate the
   key with a numeric suffix and warn.
3. **Remove throw in resultMapping.ts:** Once the above is in place, the
   duplicate-key guard in `buildNestingDescriptor` (line ~307-315) becomes
   unreachable for well-formed queries. Keep it as a defensive assertion but
   downgrade or remove.

## Open questions

- Should the warning for Scenario B be a console.warn or a structured
  diagnostic that the query builder can surface?
- Should there be an explicit API for aliasing result keys
  (e.g. `s.messages.as('recentMessages')`) to let users opt in cleanly?
- Does Scenario B actually occur in practice, or is it always a user mistake?

## Status

Ideation — not yet planned or implemented. Current workaround: fix the
duplicate at the call site.
