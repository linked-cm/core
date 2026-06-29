---
summary: A RemoteDataset adapter that accepts the lightweight QueryBuilderJSON (DSL-JSON) over the wire, lowers it to IR via fromJSON().build(), and delegates to a wrapped IDataset — keeping json -> IR -> SPARQL translation on the dataset side.
packages: [core]
status: Plan
---

# 001 — Remote Dataset (DSL-JSON over the wire)

## Problem / motivation

`IDataset` implementations currently receive the canonical **IR** (`SelectQuery` =
`IRSelectQuery`, etc.), and the only transport in-repo (`SparqlDataset`) compiles
that IR to a SPARQL string before the network call. The IR is self-contained
(IRIs resolved, alias bindings, `resultMap`, `maxCount` baked in) which makes it
large.

Measured DSL-JSON (`QueryBuilder.toJSON()`) vs IR (`build()`), `Person` fixture:

| Query | DSL-JSON | IR | IR is |
|---|---:|---:|---|
| `select(['name','hobby'])` | 91 B | 577 B | 6.3× |
| `select(p => p.friends.friends.name)` | 90 B | 569 B | 6.3× |
| `.where(name='Semmy').limit(20)` | 384 B | 582 B | 1.5× |
| `.where(friends.some(name='Moa'))` | 473 B | 710 B | 1.5× |
| `.orderBy(name DESC).offset/limit` | 168 B | 539 B | 3.2× |

The round-trip is already proven lossless by `src/tests/serialization.test.ts:116`
(`fromJSON — round-trip IR equivalence`): `QueryBuilder.fromJSON(json).build()`
reproduces byte-identical IR. So we **can** ship the lighter DSL-JSON over the
wire and lower it to IR on the receiving (dataset) side, provided that side has
the SHACL shapes registered (labels → IRIs and cardinality are recovered from the
shape during lowering).

## Architecture context

- Canonical design docs (no `docs/architecture/` folder): `documentation/intermediate-representation.md`,
  `documentation/sparql-algebra.md`; prior conversion-layer work in
  `docs/reports/005-sparql-conversion-layer.md`.
- `IDataset` (`src/interfaces/IDataset.ts`): `selectQuery(SelectQuery)`,
  optional `createQuery/updateQuery/deleteQuery` — all receive **IR**.
- `QueryBuilder.toJSON()/fromJSON()` (`src/queries/QueryBuilder.ts:429,493`) +
  `QueryBuilderSerialization.ts` — the DSL-JSON (de)serializer pair. **Select only**;
  mutation builders have no `toJSON`.
- `LinkedStorage` (`src/utils/LinkedStorage.ts`) routes IR to the resolved dataset.

### Key invariant (shape-relative vs shape-absolute)

- **IR is shape-absolute**: a dataset compiles it with zero knowledge of shapes.
- **DSL-JSON is shape-relative**: lowering needs `getShapeClass(json.shape)` /
  `walkPropertyPath` to resolve labels → IRIs and recover `maxCount`/`valueShape`.
  → The receiving `RemoteDataset` MUST have the shapes registered.

## Open-item map

| # | Item | Blocks plan? | Resolution |
|---|---|---|---|
| 1 | Which ops use DSL-JSON vs IR | yes | Select = DSL-JSON; create/update/delete = IR passthrough (no mutation toJSON exists) |
| 2 | Client serialization boundary | yes | Builder-level helper `toRemoteRequest(qb)`; no core dispatch change |
| 3 | Module placement | yes | New `src/remote/` |
| 4 | `fromJSON` throws on unknown shape/label | yes | Wrap lowering; return structured `{ok:false,error}` |
| 5 | Response envelope shape | yes | Discriminated `{ok:true,result}` \| `{ok:false,error}` |
| 6 | Mutation DSL-JSON serializers | no (defer) | Follow-up: extend toJSON to Create/Update/Delete builders |
| 7 | Transparent client IDataset (IR→DSL-JSON un-lowering) | no (defer) | Documented as not worthwhile (lossy) |

## Accepted decisions

- **D1 (1B)** — Op scope: select carried as DSL-JSON (the lightweight win);
  create/update/delete carried as IR passthrough. Rationale: only `QueryBuilder`
  has `toJSON/fromJSON`; adding mutation serializers is a separate, larger change.
  Rejected: select-only (not a usable dataset), full mutation serializers now
  (scope-creep).
- **D2 (2B)** — Client boundary: a builder-level `toRemoteRequest(qb)` helper that
  calls `qb.toJSON()` before the query enters dispatch. Rationale: `IDataset`
  receives already-lowered IR, so a transparent client would need a lossy
  IR→DSL-JSON reversal. Rejected: transparent client (lossy), core dispatch change
  (invasive).
- **D3 (3A)** — Placement: new `src/remote/` directory for transport adapters.
  Rejected: `queries/` (construction concern), `datasets/` (less precise).
- **D4** — Lowering errors (unknown shape/label) are caught and returned as a
  structured error response; server must have shapes registered (documented).
- **D5** — Response envelope is discriminated `{ok:true;result}` |
  `{ok:false;error}` for uniform transport serialization.

## Test surfaces

- Impacted package: root `@_linked/core`.
- Quick gate (target 1–2 min): `npx jest --config jest.config.js --runInBand --testPathPatterns='remote-dataset'`
  and typecheck `npx tsc -p tsconfig-cjs.json --noEmit`.
- Full/slow suite deferred to review: `npm test` (Fuseki integration tests
  self-skip when Docker is unavailable).

# Plan

## Chosen route

A single new module `src/remote/` exposing:
1. A **wire envelope** type pair (`RemoteRequest` / `RemoteResponse`).
2. A server-side **`RemoteDataset`** adapter that wraps a target `IDataset`,
   lowers `select` DSL-JSON to IR via `QueryBuilder.fromJSON(json).build()`, passes
   mutation IR straight through, and returns a discriminated response.
3. A client-side **`toRemoteRequest`** helper (builder-level for select; IR for
   mutations) so callers produce the lightweight payload before dispatch.

No changes to core dispatch, `IDataset`, or the IR pipeline.

## Inter-component contracts

```ts
// src/remote/RemoteProtocol.ts — the over-the-wire envelope
import type {QueryBuilderJSON} from '../queries/QueryBuilder.js';
import type {CreateQuery} from '../queries/CreateQuery.js';
import type {UpdateQuery} from '../queries/UpdateQuery.js';
import type {DeleteQuery} from '../queries/DeleteQuery.js';

export type RemoteRequest =
  | {op: 'select'; query: QueryBuilderJSON}   // lightweight DSL-JSON
  | {op: 'create'; query: CreateQuery}        // IR passthrough (no mutation toJSON yet)
  | {op: 'update'; query: UpdateQuery}
  | {op: 'delete'; query: DeleteQuery};

export type RemoteResponse<T = unknown> =
  | {ok: true; result: T}
  | {ok: false; error: {message: string; code: RemoteErrorCode}};

export type RemoteErrorCode =
  | 'lowering_failed'      // fromJSON/build threw (unknown shape/label, bad payload)
  | 'unsupported_op'       // op not recognised
  | 'handler_missing'      // target IDataset lacks the optional method
  | 'execution_failed';    // target dataset threw while executing
```

```ts
// src/remote/RemoteDataset.ts — server-side adapter
export class RemoteDataset {
  constructor(private readonly target: IDataset) {}

  /** Lower (if needed) and delegate one wire request to the wrapped dataset. */
  async handle(req: RemoteRequest): Promise<RemoteResponse> {
    switch (req?.op) {
      case 'select': {
        let ir: SelectQuery;
        try { ir = QueryBuilder.fromJSON(req.query).build(); }
        catch (err) { return fail('lowering_failed', err); }
        return run('execution_failed', () => this.target.selectQuery(ir));
      }
      case 'create': /* requires target.createQuery */ ...
      case 'update': ...
      case 'delete': ...
      default: return fail('unsupported_op', ...);
    }
  }
}
```

```ts
// src/remote/RemoteClient.ts — client-side payload construction
export function toRemoteRequest(qb: QueryBuilder): RemoteRequest {
  return {op: 'select', query: qb.toJSON()};   // lightweight
}
// plus createRequest/updateRequest/deleteRequest(ir) helpers for mutations
```

## Files expected to change

| File | Change |
|---|---|
| `src/remote/RemoteProtocol.ts` | NEW — envelope + error-code types, `fail`/`run` helpers |
| `src/remote/RemoteDataset.ts` | NEW — `RemoteDataset` server adapter |
| `src/remote/RemoteClient.ts` | NEW — `toRemoteRequest` + mutation request builders |
| `src/index.ts` | export `RemoteDataset`, `toRemoteRequest`, protocol types |
| `src/tests/remote-dataset.test.ts` | NEW — round-trip + error + size tests |

## Architecture compliance

- **`documentation/intermediate-representation.md`** — the store-implementer
  contract: datasets consume canonical IR. `RemoteDataset` is *upstream* of that
  contract: it produces IR via the public pipeline (`fromJSON().build()`) and hands
  the wrapped dataset exactly the IR it already expects. No IR shape change, so the
  contract is preserved.
- **`documentation/sparql-algebra.md`** — unaffected; SPARQL compilation stays
  entirely inside the wrapped dataset (`json -> IR -> SPARQL` remains the dataset's
  job, as intended).
- No architecture deviations or extensions required.

## Pitfalls

- **Shape registry requirement**: lowering needs the shapes registered on the
  server; otherwise `fromJSON` throws. Handled by `lowering_failed` error code +
  doc note. (This is the fundamental DSL-JSON tradeoff, not a bug.)
- **Optional mutation handlers**: target `IDataset` may not implement
  `createQuery/updateQuery/deleteQuery` — guard and return `handler_missing`.
- **`fromJSON` callback caveat**: a builder restored from JSON has no live
  callbacks, but `serialization.test.ts` proves the rebuilt FieldSet yields
  equivalent IR — so the round-trip is safe for the selection/where/sort/minus
  surface already covered by those tests.
- **Mutations stay heavy**: create/update/delete still ship IR; documented as the
  D1 boundary with a deferred follow-up (open-item #6).

## Test strategy

- Impacted package: root `@_linked/core` only.
- Quick gate after each phase (1–2 min): `npx jest --config jest.config.js --runInBand --testPathPatterns='remote-dataset'`
  + `npx tsc -p tsconfig-cjs.json --noEmit`.
- Full/slow suite at review: `npm test`.
- Command sources: `package.json` `test` script; jest config `jest.config.js`.
