---
summary: A RemoteDataset adapter that accepts the lightweight QueryBuilderJSON (DSL-JSON) over the wire, lowers it to IR via fromJSON().build(), and delegates to a wrapped IDataset — keeping json -> IR -> SPARQL translation on the dataset side.
packages: [core]
status: Review
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

# Review

Iteration 0 (select path) shipped and is green (1148 passing). Gaps surfaced:
G1 mutations ship heavy IR, G2 transparent client, G3 HTTP transport, G5 response
type guards, G6 round-trip breadth. **User decision:** iterate on **G1 only**, with
the broader goal that **DSL-JSON becomes the primary wire format covering ALL linked
query features, losslessly to/from JSON.** G2/G3/G5/G6 deferred to
`docs/backlog/001-remote-dataset-deferred-gaps.md`.

# Iteration 1 — Ideation (full mutation DSL-JSON)

Goal: add lossless JSON (de)serialization for create/update/delete so the wire
envelope carries DSL-JSON for mutations too (replacing iteration-0's IR passthrough).

- **iD1 — Serialization level = builder/description-level (not IR-level).** Serialize
  the normalized `NodeDescriptionValue` (`CreateQueryFactory.description` /
  `UpdateQueryFactory.fields`) — post-`.set()`, post-callback-eval, pre-IR — plus
  modes, ids, targetId, and where. On decode, rebuild the description (labels →
  `PropertyShape` via the shape) and call the SAME `buildCanonical*MutationIR`
  functions. Rationale: honors the explicit goal (DSL-JSON primary), matches the
  select path (label-based, shape-relative), and reuses the proven canonical IR
  builders for losslessness. Rejected: IR-level (simpler but "IR over the wire",
  contradicts the goal).
- **iD2 — Value codec.** Typed `MutationValueJSON` union covering every
  `PropUpdateValue` kind: `lit | date | ref | node | array | setMod | expr | unset`.
  Structural encoding (no shape needed to encode). `expr` reuses the IRExpression +
  refs encoding from select serialization; `date` uses ISO; `unset` is an explicit
  sentinel (plain JSON would drop `undefined`).
- **iD3 — Callbacks.** `UpdateBuilder.set(fn)` may hold a *function*; `toJSON`
  evaluates it via the factory (which runs `convertUpdateObject`, same as `build()`),
  so only concrete data is serialized — mirrors how `QueryBuilder.toJSON` evaluates
  `_whereFn`.
- **iD4 — Where + modes.** `update_where`/`delete_where` reuse
  `serializeWherePath`/`deserializeWherePath`; decode re-lowers via
  `toWhere → canonicalizeWhere → lowerWhereToIR`. Modes (`for`/`forAll`/`where`,
  `ids`/`all`/`where`) captured explicitly in the envelope.
- **iD5 — Wire upgrade.** `RemoteRequest` create/update/delete carry the new
  `Create/Update/DeleteMutationJSON`; `RemoteDataset` lowers via `lowerMutationJSON`.
- **iD6 — Proof.** Mirror `ir-mutation-parity.test.ts`: assert
  `lowerMutationJSON(wire(b.toJSON()))` deep-equals `b.build()` for every feature.

## Inter-component contracts

```ts
// src/queries/MutationSerialization.ts
export type MutationValueJSON =
  | {kind: 'lit'; value: string | number | boolean}
  | {kind: 'date'; value: string}                 // ISO 8601
  | {kind: 'ref'; id: string}
  | {kind: 'node'; data: MutationNodeDataJSON}
  | {kind: 'array'; items: MutationValueJSON[]}
  | {kind: 'setMod'; add?: MutationValueJSON[]; remove?: string[]}
  | {kind: 'expr'; ir: IRExpression; refs?: Record<string, string[]>}
  | {kind: 'unset'};
export type MutationFieldJSON = {prop: string; value: MutationValueJSON};   // prop = label
export type MutationNodeDataJSON = {shape: string; id?: string; fields: MutationFieldJSON[]};

export type CreateMutationJSON = {op: 'create'; shape: string; data: MutationNodeDataJSON};
export type UpdateMutationJSON = {op: 'update'; shape: string; mode: 'for'|'forAll'|'where';
  targetId?: string; where?: WherePathJSON; data: MutationNodeDataJSON};
export type DeleteMutationJSON =
  | {op: 'delete'; shape: string; mode: 'ids'; ids: string[]}
  | {op: 'delete'; shape: string; mode: 'all'}
  | {op: 'delete'; shape: string; mode: 'where'; where: WherePathJSON};
export type MutationJSON = CreateMutationJSON | UpdateMutationJSON | DeleteMutationJSON;

export function encodeNodeData(d: NodeDescriptionValue): MutationNodeDataJSON;
export function lowerMutationJSON(json: MutationJSON): CreateQuery | UpdateQuery | DeleteQuery;
```

## Iteration 1 — Plan

Files: NEW `src/queries/MutationSerialization.ts` (codec + `lowerMutationJSON`);
EDIT `CreateBuilder.ts`/`UpdateBuilder.ts`/`DeleteBuilder.ts` (add `toJSON()`);
EDIT `src/remote/RemoteProtocol.ts` (mutation ops carry MutationJSON),
`src/remote/RemoteDataset.ts` (lower via `lowerMutationJSON`),
`src/remote/RemoteClient.ts` (`toRemoteRequest` accepts mutation builders);
EDIT `src/index.ts` (exports); NEW `src/tests/mutation-serialization.test.ts`;
EDIT `src/tests/remote-dataset.test.ts` (create via DSL-JSON path).

Architecture compliance: `documentation/intermediate-representation.md` — decode calls
the canonical IR builders unchanged, so the IR contract is preserved; no IR type
changes. No `docs/architecture/` to reconcile.

Pitfalls: (a) `expr`/`date`/`unset` are the JSON-lossy kinds — explicit encoding
required. (b) decode must resolve nested shapes independently (each `node` carries its
own `shape`). (c) `$add`/`$remove` set-mod keys (with `$`) are the normalized form.
(d) reconstructed `prop` only needs `.id`, recovered from `shape.getPropertyShape(label)`.

Test strategy: quick gate `npx jest --testPathPatterns='mutation-serialization|remote-dataset'`
+ `npx tsc -p tsconfig-cjs.json --noEmit`; full `npm test` at review.

## Iteration 1 — Phases

### Phase i1 — Codec + lowerMutationJSON (`src/queries/MutationSerialization.ts`)
- JSON types above; `encodeValue`/`encodeNodeData` (structural), `decodeValue`/
  `decodeNodeData` (label→PropertyShape via shape, rebuild ExpressionNode/Date/refs),
  `lowerMutationJSON` dispatching to `buildCanonical*MutationIR` (+ where re-lowering
  for `update_where`/`delete_where`).
- **Validation:** `npx tsc -p tsconfig-cjs.json --noEmit` exits 0; covered by i3.

### Phase i2 — Builder `toJSON()` (Create/Update/DeleteBuilder)
- `CreateBuilder.toJSON()` → `{op:'create', shape, data: encodeNodeData(factory.description)}`.
- `UpdateBuilder.toJSON()` → mode + targetId/where + `encodeNodeData(factory.fields)`
  (evaluates fn-data via the factory).
- `DeleteBuilder.toJSON()` → ids/all/where envelope (where via `serializeWherePath`).
- **Validation:** typecheck exits 0; covered by i3.

### Phase i3 — Round-trip parity tests (`src/tests/mutation-serialization.test.ts`)
- For each feature from `ir-mutation-parity.test.ts`: create (simple/nested
  refs+creates/fixedId), update-for (simple/setOverwrite/unset-single/unset-multi/
  nested-with-id/nodeRef/add-remove/date/expr), update-forAll, update-where,
  delete (ids/all/where). Assert
  `sanitize(lowerMutationJSON(JSON.parse(JSON.stringify(b.toJSON())))) toEqual sanitize(b.build())`.
- **Validation:** `npx jest --testPathPatterns='mutation-serialization'` all pass.

### Phase i4 — Wire protocol + client + exports + integration
- `RemoteProtocol`: `create|update|delete` ops carry `Create|Update|DeleteMutationJSON`.
- `RemoteDataset`: mutation branches call `lowerMutationJSON(req)` (try/catch →
  `lowering_failed`) then delegate to the matching target handler.
- `RemoteClient.toRemoteRequest`: overloads to accept `QueryBuilder` (select) or a
  mutation builder (calls its `toJSON()`); keep `createRequest`/… as thin wrappers
  over `builder.toJSON()`.
- `src/tests/remote-dataset.test.ts`: switch the create test to the DSL-JSON path and
  assert the lowered IR the target receives equals `builder.build()`.
- Exports in `src/index.ts` + `src/remote/index.ts`.
- **Validation:** `npx jest --testPathPatterns='mutation-serialization|remote-dataset'`
  pass; full `npm test` green; typecheck exits 0.

## Iteration 1 — Dependency graph
`i1 → i2 → i3`; `i1 → i4` (i4 also needs i2's `toJSON`). Executed sequentially.

## Iteration 1 — Progress

- **Phase i1 — Codec + lowerMutationJSON — DONE.** `src/queries/MutationSerialization.ts`:
  JSON types, `encodeValue`/`encodeNodeData`, `decodeNodeData`/`lowerMutationJSON`
  (dispatches to `buildCanonical*MutationIR`, re-lowers where for where/forAll/delete_where).
  Validation: `npx tsc -p tsconfig-cjs.json --noEmit` exits 0; behaviour covered by i3.
- **Phase i2 — Builder toJSON — DONE.** Added `toJSON()` to `CreateBuilder`,
  `UpdateBuilder` (evaluates fn-data via factory; serializes where for where-mode),
  and `DeleteBuilder` (ids/all/where). Validation: `npx tsc -p tsconfig-cjs.json --noEmit`
  exits 0; behaviour covered by i3.
- **Phase i3 — Round-trip parity tests — DONE.** `src/tests/mutation-serialization.test.ts`
  (23 cases): create (simple/nested/fixedId), update-for (all 12 features incl. date,
  computed expression, set add/remove, unset single/multi, nested-with-id, refs),
  update forAll/where, delete ids/all/where; each asserts
  `lowerMutationJSON(wire(b.toJSON()))` ≡ `b.build()`. All pass (1171 total).
- **Phase i4 — Wire protocol + client + exports — DONE.** `RemoteRequest` mutation
  ops now carry `Create/Update/DeleteMutationJSON` (self-describing `op`);
  `RemoteDataset` lowers them via `lowerMutationJSON` with a `lowering_failed` guard;
  `RemoteClient.toRemoteRequest` is now universal (select + mutation builders); the
  IR-based `createRequest/updateRequest/deleteRequest` helpers were removed.
  `src/tests/remote-dataset.test.ts` create test switched to the DSL-JSON path + a
  mutation `lowering_failed` case. Exports added to `index.ts`/`remote/index.ts`.
  Validation: `npx tsc -p tsconfig-cjs.json --noEmit` exits 0; impacted suites green.

# Iteration 2 — Close round-trip coverage gaps

Goal: harden the "all features" guarantee surfaced in iteration-1 review.
- Gap 1: multi-segment computed-expression update (emits `traversalPatterns`).
- Gap 2: nested-create object inside a `$add` set-modification.
Test-only; fix the codec if a gap exposes a real defect. Stays in this plan doc.

## Iteration 2 — Phases
### Phase j1 — add round-trip cases to `src/tests/mutation-serialization.test.ts`
- multi-segment expression update (assign `p.bestFriend.name` to a property) →
  assert `lowerMutationJSON(wire(b.toJSON()))` ≡ `b.build()`, incl. any traversalPatterns.
- `$add` with a nested-create object (+ `$remove` ref) → assert round-trip.
- **Validation:** `npx jest --testPathPatterns='mutation-serialization'` all pass;
  full `npm test` green.

## Iteration 2 — Progress
- **Phase j1 — DONE.** Added round-trip cases: nested-create object inside `$add`
  (+ ref in `$remove`), and a multi-segment computed-expression update
  (`p.bestFriend.name.concat('!')`) — the latter exercises the `ExpressionNode`
  multi-segment-ref path and asserts the regenerated `traversalPatterns` (`__trav_0__`)
  match `build()`. Both round-trip to identical IR. Full suite: 1175 passing, 0 failing.
