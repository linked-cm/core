---
"@_linked/core": minor
---

Add `exec(target?: IDataset)` to the four query builders (`SelectBuilder`, `CreateBuilder`, `UpdateBuilder`, `DeleteBuilder`) for targeted query execution against an explicit dataset.

```ts
// Run against one specific store/router instead of the global default; the global router is untouched.
await Person.select(p => p.name).exec(someStore);
await NodeShape.create(data).withId(iri).exec(branchStore);
```

- Passing a `target` (a store, or a router — a router *is* an `IDataset`) runs the query on that dataset only. Omitting it is unchanged (global dispatch), and `await`ing a builder (the PromiseLike path) always stays global — only an explicit `.exec(target)` overrides.
- `selectQuery` is required on `IDataset`; the mutation methods are optional, so a mutation `exec(target)` **rejects** with a clear message if the target can't perform the op. All `exec` methods are now `async`, so failures (unsupported target, missing global dispatch) surface as rejected promises rather than synchronous throws.

`syncShape(target, ds?)` and `syncShapes(ds?)` now accept an optional dataset that threads through to every `.exec(ds)`. For `syncShapes`, `ds` is a plan-time parameter feeding both the orphan-detection read and the delete/create thunks, so orphans are computed against the same store they're pruned from; the returned thunks stay nullary.

```ts
const {store} = await getBranchMetadataStore(projectId, branch);
await syncShape(Person, store)(); // materialize Person's sh:NodeShape into a per-branch store
```

No routing/config/`LinkedStorage` changes — purely an execution-target override on the builder. See `docs/reports/021-targeted-query-execution.md`.
