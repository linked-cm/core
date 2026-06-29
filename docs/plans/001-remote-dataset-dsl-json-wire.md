---
summary: A RemoteDataset adapter that accepts the lightweight QueryBuilderJSON (DSL-JSON) over the wire, lowers it to IR via fromJSON().build(), and delegates to a wrapped IDataset — keeping json -> IR -> SPARQL translation on the dataset side.
packages: [core]
status: Ideation
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
