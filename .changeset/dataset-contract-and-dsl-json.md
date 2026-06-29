---
'@_linked/core': major
---

Flip the query contract: datasets receive the live query, DSL-JSON is the wire format, and the IR becomes an opt-in store detail behind a free `lower()`.

**Breaking changes**

- **`build()` is removed** from all builders. Use the free `lower(query)` function to produce IR:
  ```ts
  import {lower} from '@_linked/core';
  const ir = lower(query); // select or any mutation
  ```
- **`IDataset` methods now receive the live (closed) query object, not IR.** A dataset opts into the IR by calling `lower(query)`, or forwards the query as DSL-JSON via `query.toJSON()`:
  ```ts
  class MyStore implements IDataset {
    async selectQuery(query: SelectQuery) { return run(lower(query)); }
  }
  ```
- **`SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are now closed read-only interfaces** (the live query), not aliases of the IR. The IR types are `IRSelectQuery` / `IRCreateMutation` / `IRUpdateMutation` / `IRDeleteMutation`.
- **`QueryBuilder` is renamed to `SelectBuilder`** (a deprecated `QueryBuilder` alias is still exported).
- **`RemoteDataset` (and `RemoteClient`/`RemoteProtocol`) are removed.** Forwarding is now just an `IDataset` that ships `query.toJSON()` over your transport and rehydrates with `fromJSON(json)` on the other side.

**New: DSL-JSON, the standardized wire format**

Every query — select and every mutation — serializes losslessly to a compact, versioned JSON structure and rehydrates anywhere:

```ts
import {fromJSON} from '@_linked/core';
const json = query.toJSON();          // builder → DSL-JSON (carries a wire version `v` and the shape)
await fromJSON(json).exec();           // DSL-JSON → live query → run (kind-detected by `op`)
```

See the new [DSL-JSON specification](./documentation/dsl-json.md) for the envelope shapes, value encodings, and versioning.

**New: `{$ctx}` query-context references**

A query can reference the current context (e.g. the signed-in user) without resolving it yet — it travels on the wire as `{$ctx: "user"}` and is resolved at lowering time, whether the context is set or unset when the query is built. Works for the select subject, update target, mutation field values, delete ids, and where-clause args:

```ts
Person.select(p => p.name).for(getQueryContext('user'));   // subject: {$ctx:"user"}
Person.delete(getQueryContext('user'));                     // delete-by-context (no .for() needed)
Person.update({hobby: 'x'}).for(getQueryContext('user'));
```

Mutations throw `UnresolvedContextError` if the context isn't set at lowering; selects resolve to `null`. `subscribeQueryContext(fn)` is exported as the reactivity primitive for re-running queries when a context lands.

**New / changed exports**

`lower`, `fromJSON`, `lowerMutationJSON`, `encodeNodeData`, `decodeNodeData`, `subscribeQueryContext`, `UnresolvedContextError`, `encodeContextRef`, `isContextRefJSON`, `resolveContextId`, `CONTEXT_REF_KEY`, and the types `ContextRefJSON` / `DeleteId` / `IRSelectQuery` / `IR*Mutation`.

**Tree-shaking**

The IR pipeline (and the SPARQL layer) is reachable only through `lower()`. A client that builds, serializes, and forwards queries but never lowers them tree-shakes the entire IR + SPARQL pipeline out of its bundle. `package.json` now declares `sideEffects` accordingly.
