---
summary: Add `exec(target?: IDataset)` to the four query builders — run a query against an explicit dataset/router instead of the global LinkedStorage default — and thread an optional dataset through `syncShape`/`syncShapes`. No ambient context, no global mutation. @_linked/core only.
---

# Targeted query execution — `exec(target?)`

## Problem

A query's `.exec()` always dispatches through the **global** `getQueryDispatch()` → `LinkedStorage`
(routes by shape → default). Sometimes a caller needs to run a query against **one specific
dataset** that isn't the global default — e.g. CN materializing a shape into a per-project
branch-metadata store that lives *outside* the main router. Today the only ways are temporary
global routing mutation (races under concurrency) or a second ambient context — both undesirable.

## Solution

Let the caller pass the target explicitly. Since a router **is** an `IDataset`, `target` can be a
plain store or a router.

```ts
// SelectBuilder / CreateBuilder / UpdateBuilder / DeleteBuilder
exec(target?: IDataset): Promise<…>
//   target ? target.<kind>Query(this) : getQueryDispatch().<kind>Query(this)
```

- **No target → unchanged** (current global dispatch). `await query` (the PromiseLike path) stays
  global — only an explicit `.exec(target)` overrides.
- `target.<kind>Query(this)` hands over the **live (closed) query** — exactly the new `IDataset`
  contract; no `lower()`/IR at this layer (the store lowers it).

```ts
Person.select(p => p.name).exec(someStore);   // run on someStore, router untouched
NodeShape.create(data).withId(iri).exec(branchStore);
```

## Thread it through shape sync

`syncShape`/`syncShapes` build queries internally, so they take the optional dataset and forward it
to every `.exec(ds)`:

```ts
syncShape(target: typeof Shape | string, ds?: IDataset): () => Promise<void>
syncShapes(ds?: IDataset): Promise<Array<() => Promise<void>>>
//   ds omitted → today's global behavior (back-compatible; thunks stay nullary)
```

**Needed detail — the orphan read.** `syncShape` is pure delete→create, so `ds` only feeds its two
`.exec(ds)` calls. But `syncShapes` does an **orphan-detection read at plan time** (`NodeShape.select()`
for store shapes no longer in code) — that read **must hit the same `ds`**, or orphans get computed
against the wrong store. So `ds` is a **plan-time** param to `syncShapes` (used for both the orphan
read — `select.exec(ds)` — and threaded into every thunk), not a per-thunk arg. The returned thunks
stay `() => Promise<void>`.

## Motivating use (CN bind-Person)

```ts
const {store} = await getBranchMetadataStore(projectId, branch);
await syncShape(Person, store)();   // Person's sh:NodeShape into branch-metadata; main router untouched
```

## Tests

- `exec(target)` runs on the given dataset and **not** the global default (spy/alt store receives it;
  the default store is untouched); `exec()` with no target is unchanged. One per builder kind.
- `syncShape(Shape, store)()` materializes into `store` only; the global store is untouched.
- `syncShapes(store)` — both the orphan read **and** all delete/create hit `store` (seed an orphan in
  `store` not in code → it's pruned; a shape only in the global store is left alone).

## Out of scope

No routing/config/`LinkedStorage` changes — this is purely an execution-target override on the
builder. Supersedes the dataset-threading note in ideas-025 (single-shape sync).
