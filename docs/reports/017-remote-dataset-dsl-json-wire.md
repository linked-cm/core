---
summary: DSL-JSON is now the primary over-the-wire format for all linked queries. A RemoteDataset adapter receives lightweight DSL-JSON (select via QueryBuilderJSON, mutations via the new mutation builder toJSON), lowers it to canonical IR server-side, and delegates to a wrapped IDataset — keeping json → IR → SPARQL translation on the dataset. Includes lossless mutation (de)serialization for create/update/delete covering every value kind.
packages: [core]
---

# 017 — Remote Dataset (DSL-JSON over the wire)

## Outcome

`IDataset` implementations receive canonical **IR**; the only in-repo transport
(`SparqlDataset`) compiles that IR to SPARQL. The IR is self-contained (IRIs,
alias bindings, `resultMap`, `maxCount`) and therefore large. This work makes the
lightweight **DSL-JSON** the primary wire format for **every** query kind, lowering
it back to IR on the receiving side via the public pipeline — so a remote endpoint
keeps the `json → IR → SPARQL` translation on the dataset, exactly where it belongs.

Lossless round-trip is the contract throughout: `builder.toJSON()` → wire →
lower → IR is identical to `builder.build()`, proven by tests for select (pre-existing
`serialization.test.ts`) and for all mutations (new `mutation-serialization.test.ts`).

### Measured wire savings (select, `Person` fixture)

| Query | DSL-JSON | IR | IR is |
|---|---:|---:|---|
| `select(['name','hobby'])` | 91 B | 577 B | 6.3× |
| `select(p => p.friends.friends.name)` | 90 B | 569 B | 6.3× |
| `.where(name='Semmy').limit(20)` | 384 B | 582 B | 1.5× |
| `.orderBy(name DESC).offset/limit` | 168 B | 539 B | 3.2× |

Savings are largest for projection-heavy selects; where-clauses already embed
IR-level expressions so they shrink less. Mutation savings are modest by nature
(mutation IR data is already compact) — for writes the value is completeness and a
single consistent wire format, not size.

## Architecture

```
client:  QueryBuilder / Create|Update|DeleteBuilder
            └─ toRemoteRequest(builder) → builder.toJSON()  →  RemoteRequest (DSL-JSON)
                                                                    │  (JSON over the wire)
server:  RemoteDataset.handle(req)                                  ▼
            ├─ select : QueryBuilder.fromJSON(req.query).build() ─┐
            ├─ create : lowerMutationJSON(req) ───────────────────┤→ IR → target.<op>Query(IR)
            ├─ update : lowerMutationJSON(req) ───────────────────┤
            └─ delete : lowerMutationJSON(req) ───────────────────┘
```

The adapter is *upstream* of the `IDataset`/IR contract: it produces IR with the
same public builders the DSL uses and hands the wrapped dataset exactly the IR it
already expects. No change to core dispatch, `IDataset`, or the IR pipeline.

### Key invariant — shape-relative vs shape-absolute

- **IR is shape-absolute**: a dataset compiles it with zero knowledge of shapes.
- **DSL-JSON is shape-relative**: lowering resolves property *labels* → IRIs and
  recovers cardinality from the registered shape. **The receiving `RemoteDataset`
  MUST have the relevant SHACL shapes registered.** Unknown shape/label is reported
  as a structured `lowering_failed` response, never an unhandled throw.

## Design decisions

- **D1 — All ops use DSL-JSON.** Select carries `QueryBuilderJSON`; create/update/
  delete carry the mutation builders' new `toJSON()` output. (Iteration 0 shipped
  select-only with mutations as IR passthrough; iteration 1 replaced that with full
  mutation DSL-JSON.)
- **D2 — Client serialization boundary is the builder.** `IDataset` receives
  already-lowered IR, so a transparent client would need a lossy IR→DSL-JSON
  reversal. `toRemoteRequest(builder)` serializes before the query enters dispatch.
  No core change.
- **D3 — Placement.** Transport adapter lives in `src/remote/`; mutation
  serialization lives next to the other query serialization in `src/queries/`.
- **D4 — Structured errors.** Lowering failures are caught and returned as
  `{ok:false, error:{code:'lowering_failed', …}}`.
- **D5 — Discriminated response envelope** `{ok:true;result} | {ok:false;error}`
  for uniform transport handling.
- **iD1 — Mutation serialization unit is the normalized `NodeDescriptionValue`**
  (`CreateQueryFactory.description` / `UpdateQueryFactory.fields`) — post-`.set()`,
  post-callback-eval, pre-IR. On decode, the description is rebuilt (labels →
  `PropertyShape` via the shape) and fed to the SAME `buildCanonical*MutationIR`
  functions the builders use, guaranteeing identical IR (incl. regenerated
  `traversalPatterns` for multi-segment update expressions).
- **iD3 — Callbacks are evaluated at `toJSON` time** (the `UpdateBuilder.set(fn)`
  expression form), mirroring how `QueryBuilder.toJSON` evaluates `_whereFn`. Only
  concrete data is ever serialized.

## File structure

| File | Responsibility |
|---|---|
| `src/remote/RemoteProtocol.ts` | Wire envelope: `RemoteRequest` (select + mutation JSON), `RemoteResponse<T>`, `RemoteError`, `RemoteErrorCode`; `fail`/`run` helpers. |
| `src/remote/RemoteDataset.ts` | Server adapter `RemoteDataset.handle(req)` — lowers select via `fromJSON().build()`, mutations via `lowerMutationJSON`, delegates to a wrapped `IDataset`. |
| `src/remote/RemoteClient.ts` | `toRemoteRequest(builder)` — universal client payload builder for any select/mutation builder. |
| `src/remote/index.ts` | Barrel for the remote module. |
| `src/queries/MutationSerialization.ts` | Mutation JSON types, value/nodedata codec (`encodeNodeData`/`decodeNodeData`), and `lowerMutationJSON(json) → IR`. |
| `src/queries/{Create,Update,Delete}Builder.ts` | Added `toJSON()` emitting the mutation DSL-JSON envelope. |
| `src/index.ts` | Public exports for all of the above. |

## Public API

```ts
import {
  RemoteDataset, toRemoteRequest,            // transport
  lowerMutationJSON, encodeNodeData,         // mutation serialization
} from '@_linked/core';

// client — produce a lightweight wire payload from any builder
const req = toRemoteRequest(Person.create({name: 'Alice'}));
const res = await fetch('/query', {method: 'POST', body: JSON.stringify(req)});

// server — wrap any IDataset (e.g. a SparqlDataset) as a remote endpoint
const endpoint = new RemoteDataset(myDataset);
app.post('/query', async (r, res) => res.json(await endpoint.handle(r.body)));
```

Exports: `RemoteDataset`, `toRemoteRequest`, `RemoteRequestable`, `RemoteRequest`,
`RemoteResponse`, `RemoteError`, `RemoteErrorCode`, `lowerMutationJSON`,
`encodeNodeData`, `encodeValue`, `decodeNodeData`, and the mutation JSON types
(`MutationJSON`, `Create/Update/DeleteMutationJSON`, `MutationValueJSON`,
`MutationFieldJSON`, `MutationNodeDataJSON`). Each mutation builder gains `.toJSON()`.

### Mutation value-kind encoding

`JSON.stringify` is lossy for three kinds, so each property value is tagged:

| `PropUpdateValue` | JSON encoding |
|---|---|
| string / number / boolean | `{kind:'lit', value}` |
| `Date` | `{kind:'date', value:<ISO>}` |
| `{id}` node reference | `{kind:'ref', id}` |
| nested `NodeDescriptionValue` | `{kind:'node', data}` |
| array | `{kind:'array', items}` |
| set modification `{$add,$remove}` | `{kind:'setMod', add?, remove?}` |
| `ExpressionNode` (computed) | `{kind:'expr', ir, refs?}` |
| `undefined` (unset) | `{kind:'unset'}` |

## Error codes (`RemoteErrorCode`)

`lowering_failed` (bad payload / unregistered shape or label) · `unsupported_op` ·
`handler_missing` (target lacks the optional create/update/delete handler) ·
`execution_failed` (wrapped dataset threw).

## Test coverage

- `src/tests/remote-dataset.test.ts` — wire/handle path: select round-trip IR
  equivalence, lighter-payload assertion, select & mutation `lowering_failed`,
  create round-trip via DSL-JSON, `handler_missing`, `unsupported_op`,
  `execution_failed`.
- `src/tests/mutation-serialization.test.ts` — 25 round-trip cases asserting
  `lowerMutationJSON(wire(b.toJSON())) ≡ b.build()`: create (simple/nested
  refs+creates/fixedId); update-for (literal, set overwrite, unset single/multi,
  nested overwrite, id refs, set add/remove variants, nested-with-id, date,
  computed expression); update forAll/where; delete ids/all/where; plus iteration-2
  hardening — nested-create inside `$add`, and a multi-segment computed-expression
  update that regenerates `traversalPatterns` (`__trav_0__`) identically.
- Full suite: **1175 passing**, 0 failing (114 skipped are Fuseki integration suites
  that self-skip without Docker).

## Known limitations / deferred work

Tracked in `docs/backlog/001-remote-dataset-deferred-gaps.md`:
- **G3 HTTP transport** — `handle()` is transport-agnostic; no `fetch` client / server
  route helper yet.
- **G2 transparent `execRemote`** — callers build the request explicitly via
  `toRemoteRequest`; a `QueryBuilder.execRemote(endpoint)` would need G3.
- **G5 response type guards** — under the repo's non-strict tsconfig, control-flow
  narrowing on `RemoteResponse.ok` doesn't apply; `isOk`/`isErr` guards would help
  (tests use `toMatchObject`).
- **G4 shape-registry versioning** — no handshake guaranteeing client and server
  share identical shape definitions.

## References

- `documentation/intermediate-representation.md` — IR contract (unchanged by this work).
- `documentation/sparql-algebra.md` — SPARQL compilation (stays inside the dataset).
