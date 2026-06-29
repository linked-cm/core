---
'@_linked/core': minor
---

Add a DSL-JSON wire format and `RemoteDataset` adapter so linked queries can be sent
to a remote endpoint as lightweight JSON and lowered to IR (and on to SPARQL) on the
receiving side.

**New: `RemoteDataset`** — wrap any `IDataset` to accept wire requests:

```ts
import {RemoteDataset, toRemoteRequest} from '@_linked/core';

// server: wrap a dataset (e.g. a SparqlDataset)
const endpoint = new RemoteDataset(myDataset);
app.post('/query', async (req, res) => res.json(await endpoint.handle(req.body)));

// client: serialize any builder to a lightweight payload
const req = toRemoteRequest(Person.create({name: 'Alice'}));
await fetch('/query', {method: 'POST', body: JSON.stringify(req)});
```

`handle()` returns a discriminated `RemoteResponse` (`{ok:true,result}` |
`{ok:false,error:{code,message}}`); error codes: `lowering_failed`, `unsupported_op`,
`handler_missing`, `execution_failed`. The receiving side must have the relevant SHACL
shapes registered (DSL-JSON is label-based and lowered against the shape).

**New: mutation serialization.** `CreateBuilder`, `UpdateBuilder`, and `DeleteBuilder`
now have `.toJSON()`, and `lowerMutationJSON(json)` lowers it back to canonical IR.
The round-trip is lossless across every value kind — literals, dates, node references,
nested creates, arrays, set add/remove, computed expressions (including multi-segment),
and unset.

New exports: `RemoteDataset`, `toRemoteRequest`, `RemoteRequestable`, `RemoteRequest`,
`RemoteResponse`, `RemoteError`, `RemoteErrorCode`, `lowerMutationJSON`,
`encodeNodeData`, `encodeValue`, `decodeNodeData`, and the mutation JSON types
(`MutationJSON`, `Create/Update/DeleteMutationJSON`, `MutationValueJSON`,
`MutationFieldJSON`, `MutationNodeDataJSON`).

No changes to existing query dispatch, the `IDataset` contract, or the IR pipeline.
See `docs/reports/017-remote-dataset-dsl-json-wire.md`.
