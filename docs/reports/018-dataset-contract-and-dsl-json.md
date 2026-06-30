---
summary: Flipped the @_linked/core query contract so datasets receive the live (closed) query object, made DSL-JSON the canonical wire/interop format, demoted the IR to an opt-in store detail behind a free lower() function (removing the public build()), unified query-context references on a {$ctx} marker across every position, removed the RemoteDataset adapter, added wire versioning and mutation fromJSON, and made the IR pipeline tree-shakeable. Major version (3.0.0).
---

# 018 — Linked query contract: builders in, DSL-JSON on the wire, IR as a store detail

Supersedes report [017](./017-remote-dataset-dsl-json-wire.md) (the `RemoteDataset` adapter it
introduced was removed here — forwarding is now an ordinary `IDataset` that ships `toJSON()`).
Canonical wire spec: [documentation/dsl-json.md](../../documentation/dsl-json.md).

## Outcome

A Linked query now exists in three clearly separated tiers:

| Tier | Type(s) | Role |
|---|---|---|
| **Builder** (live) | `SelectBuilder` (was `QueryBuilder`, alias kept), `CreateBuilder`, `UpdateBuilder`, `DeleteBuilder` | the in-process working object; the dataset contract |
| **DSL-JSON** (wire) | `QueryBuilderJSON`, `CreateMutationJSON`/`UpdateMutationJSON`/`DeleteMutationJSON` | the standardized, lossless interop format |
| **IR** (algebra) | `IRSelectQuery`, `IRCreateMutation`/`IRUpdateMutation`/`IRDeleteMutation` | opt-in store lowering target (SPARQL ships in core) |

`IDataset` methods receive the **closed, read-only live query** (the builder upcast to a `*Query`
interface) — not IR. A dataset chooses what it wants: `lower(query)` for IR, `query.toJSON()` to
forward DSL-JSON, or `query.shape`/`query.toRawInput()` to handle it directly. This dissolved the
"remote vs not-remote" distinction into plain dataset polymorphism.

## Architecture & key decisions

- **Closed query as the contract (not IR).** `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery`
  are read-only interfaces (`__queryKind`, `shape`, `toJSON()`, plus `toRawInput()` for select /
  `_lowerSpec()` for mutations) that the builders satisfy structurally — a builder→closed-query upcast
  is free (same instance, narrower type). *Rationale:* a store gets a "finished query" it can read/lower
  but not keep building or re-dispatch, at zero runtime cost.
- **`lower(query)` is the single, free lowering entry point; `build()` was removed.** All IR
  construction (select + every mutation kind) lives behind `lower()`. *Rationale:* makes the IR an
  opt-in detail and the tree-shaking boundary (see below).
- **Builders are IR-free.** They hand `lower()` a plain "lowering spec" (`mutationLowerSpec`) and a raw
  select input; `lower()` owns all canonical-IR building via the IR-free `MutationQueryFactory.describe()`
  + the `buildCanonical*MutationIR` functions. The dead IR factory subclasses were removed.
- **DSL-JSON is the standardized wire format.** Property keys are shape-relative labels; values are
  tagged (`lit`/`date`/`ref`/`ctxRef`/`node`/`array`/`setMod`/`expr`/`unset`); every envelope carries a
  wire version `v`; mutations carry an `op` discriminator. `toJSON()`/`fromJSON()` round-trip losslessly.
- **`{$ctx}` context references, resolved at lowering.** A query-context reference (e.g. the current
  user) travels on the wire as `{$ctx: "<name>"}` and is resolved against the live context map at
  `lower()` time — not baked at build. Mutations throw `UnresolvedContextError` when unset; selects
  resolve to `null` (a reactive layer re-runs once the context lands). Covered positions: select subject,
  update target, mutation field values, `$remove`, delete ids, and where-clause args. Works identically
  whether the context is **set or unset** at build time.

## Pipeline (select)

`builder.toRawInput()` → `lower()` → `buildSelectQuery()` (`IRDesugar` → `IRCanonicalize` → `IRLower`) →
`IRSelectQuery`. The SPARQL dataset then runs `selectToSparql(ir)` (`irToAlgebra` → `algebraToString`).
Mutations: `builder._lowerSpec()` → `lower()` → `buildCanonical*MutationIR` → `IR*Mutation`. The wire
path mirrors this: `lowerMutationJSON(json)` and `lower(fromJSON(json))`.

## File structure

**New (`src/queries/`):**
- `lower.ts` — the free `lower()` (select via `buildSelectQuery`; mutations via `_lowerSpec()` +
  `buildCanonical*`); `resolveDescriptionContexts`/`resolveValueContexts` resolve `{$ctx}` field values.
- `lowerMutationJSON.ts` — the IR side of mutation wire decoding (`decodeNodeData`, `lowerMutationJSON`);
  isolated here so the wire codec stays IR-free.
- `mutationLowerSpec.ts` — `Create/Update/DeleteLowerSpec` (the IR-free hand-off from builder to `lower()`).
- `ContextRef.ts` — the `{$ctx}` marker (`CONTEXT_REF_KEY`, `encodeContextRef`, `isContextRefJSON`,
  `resolveContextId`).
- `fromJSON.ts` — kind-detecting umbrella `fromJSON(json)` (routes by `op`; throws on unknown `op`).
- `wireVersion.ts` — `WIRE_VERSION='1.0'` + `assertWireVersion` (tolerates missing `v`, rejects unknown major).

**Changed (highlights):**
- `QueryBuilder.ts` — class renamed `SelectBuilder` (deprecated `QueryBuilder` alias kept); `build()`
  removed; `toRawInput()`/`toJSON()`/`fromJSON()`; subject carries `{$ctx}`; `exec()` returns null on
  unresolved where-context.
- `CreateBuilder/UpdateBuilder/DeleteBuilder.ts` — `_lowerSpec()` + `toJSON()`/`fromJSON()`; IR-free.
- `SelectQuery.ts`/`CreateQuery.ts`/`UpdateQuery.ts`/`DeleteQuery.ts` — the closed query interfaces +
  `IR*` type aliases.
- `MutationQuery.ts` — IR-free `describe()`/`normalizeNodeRefs()`; preserves a context value via `asContextRef`.
- `MutationSerialization.ts` — IR-free wire codec (`encodeNodeData`/`decodeNodeDataToRaw`).
- `QueryContext.ts` — `PendingQueryContext`, `UnresolvedContextError`, `subscribeQueryContext`,
  `asContextRef`, `__queryContextName` stamping, reordered `setQueryContext`.
- `IRLower.ts` — `resolveContextRefs` resolves `{$ctx}` in where AND projected expressions.
- `irToAlgebra.ts` — `resolvedContextIri` defensive guard.
- `IntermediateRepresentation.ts` — `reference_expr.value`/`context_property_expr.contextIri` optional +
  `contextName?`.
- `LinkedStorage.ts` — routes by `query.shape`; missing-shape guard on all ops; `IDataset | undefined`.
- `SparqlDataset.ts` — calls `lower(query)` internally.
- `Shape.ts` — `delete()` accepts a context (`DeleteId`); `__queryContextName` field.
- **Deleted** `src/remote/*` (`RemoteDataset`, `RemoteClient`, `RemoteProtocol`, barrel).

## Public API (selected)

```ts
import {
  SelectBuilder, CreateBuilder, UpdateBuilder, DeleteBuilder,
  lower, fromJSON,                                  // IR + inbound rehydration
  getQueryContext, setQueryContext, subscribeQueryContext,
  PendingQueryContext, UnresolvedContextError,
  encodeContextRef, isContextRefJSON, resolveContextId, CONTEXT_REF_KEY,
  lowerMutationJSON, decodeNodeData, encodeNodeData,
  type DeleteId, type ContextRefJSON,
} from '@_linked/core';

const json = query.toJSON();          // builder → DSL-JSON
await fromJSON(json).exec();           // DSL-JSON → live query → run
const ir = lower(query);               // opt into IR (what SparqlDataset does)
await Person.delete(getQueryContext('user'));   // delete-by-context (no .for() needed)
```

## Gaps resolved (two review passes)

First pass (contract/boundary hardening): silent `{id:undefined}` on unset-context mutation field
values → throw; wire-version assertion added to **all** inbound paths; unknown `op` throws instead of
misrouting to select; mutation routing missing-shape guard + `IDataset|undefined`; nested-exists chain
truncation made loud; `targetContextName` clearing + listener-snapshot.

Second pass (integration/blast-radius):
- **Projected-expression context refs** reached SPARQL unresolved and crashed → `resolveContextRefs`
  now runs on projection expressions too (not just where); plus a defensive `resolvedContextIri` guard
  in `irToAlgebra` (since `strictNullChecks` is off).
- **`Shape.delete()`** widened to accept a context (cast-free `Person.delete(getQueryContext('user'))`).
- **Context set at build time** (a resolved `QueryShape`, not a `PendingQueryContext`) broke
  delete/field-value context (threw) → `asContextRef()` normalizes both set and unset forms to `{$ctx}`.
- **Context property as the self of an expression** (`getQueryContext('user').name.equals(x)`) was traced
  as a root property → `wrapWithExpressionProxy` routes the self through `toExpressionNode`.
- `setQueryContext` no longer no-ops on a `Shape`/`QueryShape` + id without `shapeType`; `DeleteId`
  exported.

## Tree-shaking (verified)

The IR pipeline (`IRPipeline`/`IRMutation`/`IRLower`/`IRDesugar`/`IRCanonicalize`) is reachable **only**
through `lower()` and `lowerMutationJSON()`. Verified by import-graph analysis: `Shape`, `QueryBuilder`,
all mutation builders, `fromJSON`, `MutationSerialization`, and `index` reach **zero** IR modules
(`index` reaches only the opt-in SPARQL dataset). `package.json` `sideEffects` lists only the ontologies
and `utils/Package` (the bootstrap with import-time effects), propagated into the dual-package
`lib/cjs` / `lib/esm` manifests. A client that builds/forwards queries but never calls `lower()` drops
the entire IR + SPARQL pipeline from its bundle.

## Test coverage

Full suite **1198 passing** (3 Fuseki suites skipped — require Docker), CJS+ESM typecheck clean. Key
test files for this scope: `lower.test.ts` (lower parity), `mutation-serialization.test.ts` (DSL-JSON
round-trip across all kinds/modes, wire-version + unknown-op guards, `{$ctx}` field/delete/set-at-build,
context parity), `query-builder.test.ts` (select subject `{$ctx}`, where-arg + projected-expression +
context-property-self context resolution, exec→null), `core-utils.test.ts` (routing missing-shape +
`setQueryContext` inputs), `store-routing.test.ts`, `ir-select-golden.test.ts`, `sparql-*-golden`.

## Documentation

- **New** `documentation/dsl-json.md` — the canonical wire-format spec (envelopes, versioning, value
  encodings, `{$ctx}`, the `toJSON`/`fromJSON`/`lower` API, cross-language guidance).
- `documentation/intermediate-representation.md` — reframed: DSL-JSON is the contract, IR is the internal
  SPARQL lowering (usable as-is for other target languages or as inspiration); store guide rewritten to
  `IDataset` receiving the live query + `lower()`; `IQuadStore`→`IDataset`; removed factory `build()` refs.
- `documentation/sparql-algebra.md` — `IQuadStore`→`IDataset` + internal `lower()`.
- `README.md` — prominent "DSL-JSON — the standard query format" section with examples; IR reframed into a
  "Datasets, target languages, and the IR" section; `.build()`→`lower()`; `QueryBuilder` noted as the
  `SelectBuilder` alias.
- Superseded/obsolete banners on report 017 and backlog 001.

## Breaking changes (3.0.0)

- `build()` removed from all builders — use the free `lower(query)`.
- `IDataset` methods now receive the **live closed query**, not IR — call `lower(query)` for IR.
- `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are now closed interfaces (the live query), not
  IR aliases — the IR types are `IRSelectQuery`/`IR*Mutation`.
- `QueryBuilder` class renamed to `SelectBuilder` (deprecated alias retained).
- `RemoteDataset`/`RemoteClient`/`RemoteProtocol` removed — forwarding is an `IDataset` that ships `toJSON()`.

## Known limitations / deferred

- **Gap 4 (deferred):** a context-*property* reference in a where while the context is **unset**
  (`getQueryContext('unset').name.gt(...)`) throws at build — a `PendingQueryContext` has no shape, so the
  property IRI can't be resolved. Supporting it needs a *typed* pending context (carrying an expected
  shape). Root-ref and set-context property access both work.
- `decodeValue` (IR) and `decodeValueToRaw` (raw) are deliberately mirrored; the `$ctx` value codec is the
  reachable inbound path for context field values.
