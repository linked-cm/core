---
summary: A RemoteDataset adapter that accepts the lightweight QueryBuilderJSON (DSL-JSON) over the wire, lowers it to IR via fromJSON().build(), and delegates to a wrapped IDataset — keeping json -> IR -> SPARQL translation on the dataset side.
packages: [core]
status: Implementation
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

# Tasks

## Dependency graph

```
Phase 1 (protocol types) ──> Phase 2 (RemoteDataset) ──> Phase 4 (exports + tests + integration)
                        └──> Phase 3 (RemoteClient) ──┘
```

Phase 1 establishes the contract. Phases 2 and 3 both depend only on Phase 1 and
**can run in parallel** (different files, no shared writes). Phase 4 integrates
(barrel exports + end-to-end test) and must run last. Given the small surface,
phases will be executed sequentially in one session, but the graph is recorded for
fidelity.

## Phase 1 — Protocol types (`src/remote/RemoteProtocol.ts`)

- Create `RemoteRequest`, `RemoteResponse<T>`, `RemoteErrorCode` exactly as in the
  Contracts section.
- Add internal helpers: `fail(code, err): RemoteResponse` and
  `run<T>(code, fn): Promise<RemoteResponse<T>>` (try/catch wrapper) — exported for
  reuse by `RemoteDataset`.
- Imports are `import type` only (no runtime deps) except the helper functions.

**Validation (quick gate):**
- `npx tsc -p tsconfig-cjs.json --noEmit` exits 0.
- Manual structural check: `RemoteErrorCode` union contains exactly the four codes
  `lowering_failed | unsupported_op | handler_missing | execution_failed`.

## Phase 2 — Server adapter (`src/remote/RemoteDataset.ts`)

- `class RemoteDataset { constructor(private readonly target: IDataset) {} }`.
- `async handle(req: RemoteRequest): Promise<RemoteResponse>` switching on `req.op`:
  - `select`: `QueryBuilder.fromJSON(req.query).build()` inside try/catch →
    `lowering_failed` on throw; else `run('execution_failed', () => target.selectQuery(ir))`.
  - `create|update|delete`: if the optional `target.<op>Query` is missing →
    `fail('handler_missing')`; else `run('execution_failed', () => target.<op>Query(req.query))`.
  - default/unknown `op` → `fail('unsupported_op')`.
- Depends on: Phase 1 types. (Stub: if built in parallel, hand-author the
  `RemoteRequest`/`RemoteResponse` shapes locally — but here Phase 1 lands first.)

**Validation (quick gate):**
- `npx tsc -p tsconfig-cjs.json --noEmit` exits 0.
- Covered by Phase 4 tests (no separate test file).

## Phase 3 — Client helper (`src/remote/RemoteClient.ts`)

- `toRemoteRequest(qb: QueryBuilder): RemoteRequest` → `{op:'select', query: qb.toJSON()}`.
- `createRequest(ir)`, `updateRequest(ir)`, `deleteRequest(ir)` → wrap IR in the
  envelope with the matching `op`.
- Depends on: Phase 1 types + existing `QueryBuilder`.

**Validation (quick gate):**
- `npx tsc -p tsconfig-cjs.json --noEmit` exits 0.

## Phase 4 — Exports + tests + integration (`src/index.ts`, `src/tests/remote-dataset.test.ts`)

- Add to `src/index.ts`: `export {RemoteDataset} from './remote/RemoteDataset.js'`,
  `export {toRemoteRequest, createRequest, updateRequest, deleteRequest} from './remote/RemoteClient.js'`,
  `export type {RemoteRequest, RemoteResponse, RemoteErrorCode} from './remote/RemoteProtocol.js'`.
- Add a `RemoteModule` namespace import to the `initModularApp()` `publicFiles` map
  for parity with siblings.
- New test file `src/tests/remote-dataset.test.ts` with a `RecordingDataset`
  fake `IDataset` (captures the IR it receives, returns canned results).

**Test specifications:**

- `` `select round-trip — IR equivalence` `` — build
  `QueryBuilder.from(Person).select(['name','hobby']).where(p => p.name.equals('Semmy')).limit(20)`.
  `JSON.parse(JSON.stringify(toRemoteRequest(qb)))` → `new RemoteDataset(rec).handle(req)`.
  Assert `rec.lastSelect` (the IR the fake received) `toEqual` `sanitize(qb.build())`
  and that the response is `{ok:true, result: <canned>}`.
- `` `select round-trip — payload is lighter than IR` `` — assert
  `JSON.stringify(req.query).length < JSON.stringify(qb.build()).length` for a
  projection-only query (documents the wire win).
- `` `select — lowering_failed on unknown shape` `` — hand-craft
  `{op:'select', query:{shape:'urn:does-not-exist', fields:[{path:'x'}]}}`; assert
  response `{ok:false, error.code:'lowering_failed'}` and that `target.selectQuery`
  was never called.
- `` `create passthrough` `` — `createRequest(ir)` where `ir` is a minimal
  `IRCreateMutation`; assert `rec.lastCreate toEqual ir` and `{ok:true}`.
- `` `handler_missing` `` — wrap a target with no `createQuery`; assert
  `{ok:false, error.code:'handler_missing'}`.
- `` `unsupported_op` `` — pass `{op:'frobnicate'} as any`; assert
  `{ok:false, error.code:'unsupported_op'}`.
- `` `execution_failed` `` — target whose `selectQuery` rejects; assert
  `{ok:false, error.code:'execution_failed'}` and the message is surfaced.

**Validation (quick gate):**
- `npx jest --config jest.config.js --runInBand --testPathPatterns='remote-dataset'`
  — all cases above pass.
- `npx tsc -p tsconfig-cjs.json --noEmit` exits 0.

**Full review gate (deferred):** `npm test` — assert no regressions in the existing
1141-passing suite.

# Implementation progress

- **Phase 1 — Protocol types — DONE.** Created `src/remote/RemoteProtocol.ts`
  (`RemoteRequest`, `RemoteResponse<T>`, `RemoteError`, `RemoteErrorCode` with the
  four codes, plus `fail`/`run` helpers). Validation: `npx tsc -p tsconfig-cjs.json --noEmit`
  exits 0.
- **Phase 2 — Server adapter — DONE.** Created `src/remote/RemoteDataset.ts`
  (`RemoteDataset.handle()`: select lowers via `fromJSON().build()` with a
  `lowering_failed` guard; create/update/delete passthrough with `handler_missing`
  guards; `unsupported_op` default). Validation: `npx tsc -p tsconfig-cjs.json --noEmit`
  exits 0; behaviour covered by Phase 4 tests.
- **Phase 3 — Client helper — DONE.** Created `src/remote/RemoteClient.ts`
  (`toRemoteRequest(qb)` → DSL-JSON select envelope; `createRequest`/`updateRequest`/
  `deleteRequest` → IR envelopes). Validation: `npx tsc -p tsconfig-cjs.json --noEmit`
  exits 0.
- **Phase 4 — Exports + tests + integration — DONE.** Added `src/remote/index.ts`
  barrel; wired named + namespace (`RemoteModule`) exports into `src/index.ts`.
  Created `src/tests/remote-dataset.test.ts` (7 cases: IR-equivalence round-trip,
  lighter-payload, `lowering_failed`, create passthrough, `handler_missing`,
  `unsupported_op`, `execution_failed`). Validation: targeted suite passes (7/7);
  `npx tsc -p tsconfig-cjs.json --noEmit` exits 0; full run 1148 passed / 0 failed
  (was 1141 — +7 new, no regressions).
  - Note: response narrowing relied on a discriminated union; under this repo's
    non-strict tsconfig, control-flow narrowing on the boolean discriminant did not
    apply in tests, so assertions use `toMatchObject` (more robust). Flagged for
    review as a potential ergonomics gap for consumers.
