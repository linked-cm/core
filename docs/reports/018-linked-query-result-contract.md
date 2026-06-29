---
summary: Preserve nested linked-query container keys separately from child field keys during IR lowering and SPARQL result hydration.
---

# 018 — Linked Query Result Contract

## Summary

Nested linked-query result hydration now preserves the outer container key and
the inner projected field key as separate concepts.

The concrete contract is:

```ts
image: action.image.select((img) => [img.contentUrl])
```

hydrates as:

```ts
{ image: { id, contentUrl } }
```

Before this fix, the outer custom key could be propagated into the nested child
projection and produce:

```ts
{ image: { id, image: "/images/banners/empowerment.webp" } }
```

## Problem

The select-lowering pipeline used one result-map `key` for both custom aliases
and projected field names. That is enough for flat selections:

```ts
displayName: action.name
```

but ambiguous for nested custom containers:

```ts
image: action.image.select((img) => [img.contentUrl])
```

In that nested case:

- `image` names the containing object.
- `contentUrl` names the projected child field.

The previous result-map shape could not express both at once, so the outer key
could become the child field key. Result hydration then produced the wrong
runtime object shape even when SPARQL selected the correct variable.

## Final Behavior

The pinned behavior is:

```ts
image: action.image.select((img) => [img.contentUrl])
// -> { image: { id, contentUrl } }
```

```ts
displayName: action.name
// -> { displayName: "..." }
```

```ts
image: action.image.select((img) => ({ url: img.contentUrl }))
// -> { image: { id, url } }
```

The generated SPARQL does not need to change. The fix is in the result contract
metadata and hydration path.

## Architecture

The result-map metadata now distinguishes:

- `key`: the projected field key
- `containerKey`: optional nested container key
- `alias`: the projection alias/SPARQL variable linkage

Pipeline:

```text
custom object key around sub_select
  -> IRLower ProjectionSeed.containerKey
  -> IRResultMapEntry.containerKey
  -> resultMapping NestedGroup.key
```

Flat custom aliases do not get `containerKey`; their custom key remains the
field key.

## Files Changed

| File | Responsibility |
|---|---|
| `src/queries/IntermediateRepresentation.ts` | Adds optional `containerKey` to `IRResultMapEntry`. |
| `src/queries/IRLower.ts` | Treats a custom key around a `sub_select` as the nested container key instead of propagating it as the child field key. |
| `src/sparql/resultMapping.ts` | Uses `containerKey` when creating nested result groups. |
| `src/tests/query-builder.test.ts` | Regression coverage for lowered result-map shape. |
| `src/tests/sparql-result-mapping.test.ts` | Hydration regression coverage for nested container and child field keys. |

## Design Decisions

1. **Fix core, not component fallbacks.** Components should consume stable
   linked-query result contracts. App-level fallbacks for `{image: {image}}`
   would preserve a serialization bug.

2. **Generic metadata, no image special-case.** The fix applies to any nested
   container key, not only `schema:image` or `contentUrl`.

3. **Keep SPARQL generation unchanged.** Existing logs and golden tests showed
   the selected variables were already correct; the bug was after execution.

4. **Preserve flat aliases.** `displayName: action.name` remains a flat field
   alias and does not become a nested container.

5. **Preserve explicit inner aliases.** In
   `image: action.image.select(img => ({url: img.contentUrl}))`, `url` remains
   the child field key.

## Test Coverage

`src/tests/query-builder.test.ts` covers the lowered result-map shape:

- flat alias preservation
- nested custom container key plus bare inner field
- nested custom container key plus explicit inner alias

`src/tests/sparql-result-mapping.test.ts` covers hydration:

- `{displayName: "..."}`
- `{image: {id, contentUrl}}`
- `{image: {id, url}}`

`src/tests/sparql-select-golden.test.ts` remained green, confirming SPARQL
generation did not change.

## Compatibility

This is a patch behavior fix. Consumers that were reading the accidental nested
child key, such as `image.image`, should switch to the projected child key, such
as `image.contentUrl`.
