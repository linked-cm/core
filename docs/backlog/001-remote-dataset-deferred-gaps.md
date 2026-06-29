---
summary: Deferred follow-up work for the RemoteDataset DSL-JSON wire format (plan 001) — HTTP transport, transparent client execRemote, response type guards, and a broader round-trip test matrix. Deferred while plan 001 iteration 1 focuses on full mutation DSL-JSON coverage.
packages: [core]
---

# 001 — RemoteDataset deferred gaps

Source: review of `docs/plans/001-remote-dataset-dsl-json-wire.md`. The user chose to
iterate on **G1 (mutation DSL-JSON)** only; the items below are deferred with the
context known at review time. Do not expand scope beyond what is captured here.

## G3 — HTTP transport binding

- **Need:** `RemoteDataset.handle()` is transport-agnostic (consumes a parsed
  `RemoteRequest`). There is no `fetch`-based client nor a server route helper.
- **Known shape:** a thin client that POSTs `JSON.stringify(toRemoteRequest(qb))`
  and unwraps `RemoteResponse`; a framework-agnostic request handler
  `(body) => endpoint.handle(body)`.
- **Open questions:** error/status-code mapping (e.g. `lowering_failed` → 400,
  `execution_failed` → 500); streaming for large select results; auth.

## G2 — Transparent client (`QueryBuilder.execRemote`)

- **Need:** callers currently build the request manually with `toRemoteRequest`.
  A transparent path (register a remote endpoint and call `.exec()`) is blocked
  because dispatch lowers to IR before a dataset sees it, and IR→DSL-JSON is lossy.
- **Known shape:** `QueryBuilder.execRemote(endpoint)` that serializes at the
  builder level, or a dispatch hook that passes the builder. Depends on G3.

## G5 — Response type guards

- **Need:** under the repo's non-strict tsconfig, control-flow narrowing on the
  `RemoteResponse.ok` discriminant does not apply, so consumers can't write
  `if (!res.ok) res.error`.
- **Known shape:** export `isOk(res)` / `isErr(res)` (and maybe `assertOk`)
  from `RemoteProtocol`. Tests currently use `toMatchObject` to sidestep this.

## G6 — Round-trip breadth matrix

- **Need:** select round-trip correctness rides on `serialization.test.ts`.
- **Known shape:** a parametrized matrix exercising exists/minus/argPath/preload/
  aggregation across `query-fixtures` shapes, asserting `fromJSON().build()` IR
  equivalence for each. Extend to mutations once G1 lands.
