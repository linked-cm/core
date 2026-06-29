---
summary: Flip the dataset contract so datasets receive the live linked query object (the builder); make DSL-JSON the wire/interop format produced on demand at boundaries; make the IR an opt-in store detail behind a free lower() function (no public .build()); add mutation fromJSON; remove the RemoteDataset adapter; make query context a first-class JSON value with mutation parity; document the JSON spec; enable tree-shaking. Major version.
packages: [core]
status: Implementation
---

# 002 — Linked query contract: builders in, JSON on the wire, IR as a store detail

## Problem / motivation

Today `IDataset` receives the **IR** (`SelectQuery = IRSelectQuery`, …); `QueryBuilder.exec()`
lowers to IR via the public `build()` method and dispatches that. The IR is the contract
every store must speak. This forces lowering even for in-process stores, anchors the IR
pipeline into the always-imported `QueryBuilder` (so it can never be tree-shaken), and
leaves three representations (builder / JSON / IR) wired in an ad-hoc way (see superseded
`docs/reports/017`, which added a side-car `RemoteDataset` JSON adapter).

We want a single coherent model:

- **Builder** = the live linked query object. The universal in-process currency and the
  **dataset contract** — datasets receive it and decide what to do.
- **DSL-JSON** = the wire/interop format. Produced on demand (`toJSON`) only at a process
  or language boundary; rehydrated (`fromJSON`) on the way in. This is what Rust/Logos and
  any non-JS endpoint speaks, and what gets documented as the canonical spec.
- **IR** = a shape-resolved algebra that *some* stores (e.g. SPARQL) choose to lower to,
  via a free `lower(query)` function. An implementation detail, not the contract.

This dissolves the "remote vs not-remote" distinction: it is pure dataset polymorphism.
An in-memory store uses the builder directly; a SPARQL store calls `lower()`; a forwarding
store calls `toJSON()` and ships it. No framework-level remoteness flag.

## Chosen route (Option 1 — builder in, closed query as the contract)

Datasets receive the live query. The builder is renamed for symmetry and the dataset-facing
contract is a **closed (read-only) interface** the builder implements — so a store gets a
"finished query" it can read/lower but not keep building, at **zero runtime cost** (it is the
same instance, viewed through a narrower type — a free upcast, no new object, no rebuild).
The inbound boundary of any process rehydrates incoming JSON → builder once (`fromJSON`);
everything internal is a builder (routing introspects it; stores `lower()` it or read it).

**Rejected — Option 2** (`JsonBackedQuery` wrapper + per-dataset `toBuilder()`): its only win
is a free content-blind JSON→JSON relay, which never triggers in an inspect-to-route
architecture, and it adds `toBuilder()` ceremony everywhere.

## Naming & three-tier types

Builders (the extendable, fluent objects you construct with):
`SelectBuilder` (renamed from `QueryBuilder`, with a **deprecated `QueryBuilder` alias**),
`CreateBuilder`, `UpdateBuilder`, `DeleteBuilder`.

| Tier | Type | Was | Role |
|---|---|---|---|
| Live (closed) | `SelectQuery` = **closed read-only interface** impl. by `SelectBuilder` | alias of IR | what datasets receive (reuses the name → `IDataset` signature unchanged) |
| Wire | `SelectQueryJSON` (= today's `QueryBuilderJSON`) | n/a | crosses boundaries |
| Algebra | `IRSelectQuery` | `SelectQuery` | optional store lowering target |

Same per kind: `CreateQuery`/`UpdateQuery`/`DeleteQuery` become the closed interfaces the
mutation builders implement; IR → `IRCreate/Update/DeleteMutation`. `LinkedQuery` is the
umbrella supertype of the four closed `*Query` interfaces.

## Inter-component contracts

```ts
// Umbrella for generic/client code (kind-detecting fromJSON, dispatch)
interface LinkedQuery {
  toJSON(): QueryJSON;
  readonly shape: NodeShape;
  exec(): Promise<unknown>;        // client-side dispatch; NOT on the dataset-facing *Query
}

// Closed, read-only, dataset-facing contract (reuses the existing names)
interface SelectQuery {            // implemented by SelectBuilder
  toJSON(): SelectQueryJSON;
  readonly shape: NodeShape;       // routing without forcing a lower()
  toRawInput(): RawSelectInput;    // read-only hook lower() consumes (no mutation)
  // NOTE: no .where()/.limit()/… (closed) and no exec() (no accidental re-dispatch)
}
// CreateQuery / UpdateQuery / DeleteQuery — analogous closed interfaces.

// IDataset — signature UNCHANGED; SelectQuery now denotes the closed live query
interface IDataset {
  selectQuery(query: SelectQuery): Promise<SelectResult>;
  createQuery?(query: CreateQuery): Promise<CreateResult>;
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}

// IR lowering — a FREE function (tree-shaking boundary), not a method. Replaces build().
function lower(query: SelectQuery): IRSelectQuery;
function lower(query: CreateQuery): IRCreateMutation;   // …overloaded per kind

// Rehydrate JSON → builder (builder satisfies the closed *Query interface)
function fromJSON(json: QueryJSON): LinkedQuery;        // kind-detecting; inbound = fromJSON(json).exec()
SelectBuilder.fromJSON(json: SelectQueryJSON): SelectBuilder;   // exists (renamed from QueryBuilder.fromJSON)
CreateBuilder.fromJSON(json: CreateMutationJSON): CreateBuilder;  // NEW
UpdateBuilder.fromJSON(json: UpdateMutationJSON): UpdateBuilder;  // NEW
DeleteBuilder.fromJSON(json: DeleteMutationJSON): DeleteBuilder;  // NEW
```

Builder→closed-query is a free upcast (same instance). A store reads whichever projection it
wants — `lower(q)` for IR, `q.toJSON()` for the wire — with no extra hop:

```ts
class SparqlDataset { selectQuery(q: SelectQuery) { return run(selectToSparql(lower(q), opts)); } }
class InMemoryDataset { selectQuery(q: SelectQuery) { /* lower(q) → IR, or read q.toRawInput() */ } }
// Forwarding is just an IDataset that calls q.toJSON() and ships it — NOT shipped in core (do later).
```

## Files expected to change

| Area | Files | Change |
|---|---|---|
| Lowering | NEW `src/queries/lower.ts`; `QueryBuilder.ts`(→`SelectBuilder.ts`), `*Builder.ts` | add free `lower()`; remove public `build()`; expose `toRawInput()`/description for `lower()` |
| Rename | `QueryBuilder.ts` → `SelectBuilder` (keep `QueryBuilder` alias export); update `Shape.select`, tests, `index.ts` | symmetry with `CreateBuilder`/… |
| Naming | `SelectQuery.ts`, `CreateQuery.ts`, `UpdateQuery.ts`, `DeleteQuery.ts`, ~23 IR-consuming files | `SelectQuery` etc. become closed interfaces; migrate IR-meaning uses → `IRSelectQuery`/`IR*Mutation` |
| Contract | `interfaces/IDataset.ts` (signature unchanged), `queries/queryDispatch.ts`, `utils/LinkedStorage.ts`, builder `exec()` | datasets receive the closed query; `exec()` dispatches the builder; route by `query.shape` |
| SPARQL | `sparql/SparqlDataset.ts` | call `lower()` internally |
| Mutation rehydrate | `CreateBuilder.ts`, `UpdateBuilder.ts`, `DeleteBuilder.ts`, `MutationSerialization.ts` | add `fromJSON` (json → builder) + kind-detecting `fromJSON` |
| Remove adapter | `src/remote/*` (4 files) + `remote-dataset.test.ts` | delete |
| Context | builders, `QueryBuilderSerialization.ts`, `MutationSerialization.ts`, lowering | first-class context ref encoding + resolution + mutation parity |
| Tree-shaking | `package.json` | `sideEffects` config |
| Docs | NEW `documentation/dsl-json.md`, `README.md`, rewrite store guide in `documentation/intermediate-representation.md`; replace report 017 | spec + guide |

## Architecture compliance

- **`documentation/intermediate-representation.md`** — the store-implementer guide currently
  says "your store receives canonical IR." This work **changes that contract** (stores
  receive the builder; IR is opt-in via `lower()`). This is an approved architecture change
  (directed in this plan); the guide is rewritten in Phase 8, with IR repositioned as an
  internal algebra and `lower()` documented.
- **`documentation/sparql-algebra.md`** — unaffected; SPARQL still compiles from IR, now
  produced inside `SparqlDataset` via `lower()`.
- New **`documentation/dsl-json.md`** becomes the canonical wire-format spec.

## Pitfalls

- **`SelectQuery` repoint is wide** (~23 IR-meaning references). Mechanical but must be
  exhaustive or the build breaks; do it as one focused pass.
- **Routing key moves**: `LinkedStorage` reads `query.root.shape` (IR) today; the builder
  exposes a top-level `shape` — both the router and its validity checks must switch.
- **`exec()` must dispatch the builder**, not `build()`/`toJSON()`; double-check the
  PromiseLike path and the `nullSubject`/pending guards still apply.
- **`build()` removal** ripples to tests and any external caller — major version; provide a
  clear migration note (`build()` → `lower(query)`).
- **Tree-shaking** requires `lower()` to be the *only* thing importing the IR pipeline;
  ensure `QueryBuilder` no longer imports `IRPipeline` after `build()` is removed.
- **Context** changes select's current "pending → exec returns null" to "throw if
  unresolvable at lowering"; audit callers.
- **`sideEffects: false`** is unsafe as-is: `LinkedStorage` (instance counter) and
  `index.ts` (`initModularApp`) have import-time side effects — list them explicitly or
  refactor the side effects out first.

## Test strategy

- Impacted package: root `@_linked/core`.
- Quick gate per phase (target 1–2 min): targeted `npx jest --testPathPatterns=<files>` +
  `npx tsc -p tsconfig-cjs.json --noEmit`.
- Full gate at review: `npm test` (Fuseki suites self-skip without Docker).
- Keep the existing select round-trip (`serialization.test.ts`) and mutation round-trip
  (`mutation-serialization.test.ts`) green throughout; extend them for `fromJSON`/builder
  parity and context.

## Resolved decisions (all confirmed)
1. **Name = `lower(query)`**.
2. **No `ForwardingDataset` in core** (do it later if needed). Inbound rehydrate is just
   `fromJSON(json).exec()` — provide a **kind-detecting `fromJSON(json) → builder`** (the
   per-kind `fromJSON`s exist after Phase 4); no `op` param, no new routing helper.
3. **Context = all positions at once**: subject `.for()`, where-args, and mutation values in
   one Phase 6.
4. **DSL-JSON format version = `"1.0"`, shipped now** (top-level `v`). Package bump =
   **major → 3.0.0** (package stays on its 2.x→3.0.0 line; `1.0` referred to the wire format).
5. **Builder vs query (closed)** — `SelectBuilder` is the extendable builder; **`SelectQuery`
   (reused name) is a closed read-only interface** the builder implements; datasets receive
   the closed `*Query`. Builder→query is a **free upcast** (same instance, zero hop). IR →
   `IRSelectQuery`. `LinkedQuery` umbrella (`toJSON`/`shape`/`exec`) for generic code.

# Tasks

Conventions: each phase = one commit (parallel groups = one commit after integration).
Quick gate after every phase = targeted `npx jest --testPathPatterns=<files>` +
`npx tsc -p tsconfig-cjs.json --noEmit`. Full `npm test` runs at review. Golden baseline to
preserve: `serialization.test.ts`, `mutation-serialization.test.ts`, `ir-select-golden`,
`sparql-*-golden`, `store-routing`.

## Dependency graph & parallel groups
```
P1 (lower)
 ├─ P2 (contract flip)            ── after P1
 └─ P4 (mutation fromJSON)        ── after P1        [P2 ∥ P4]
P3 (SparqlDataset)                ── after P2
P7 (tree-shaking)                 ── after P1,P2     [P3 ∥ P7]
P5 (remove remote + kind fromJSON)── after P2,P4
P6 (context, all positions)       ── after P2,P4     [P5 ∥ P6]
P8 (docs + version + changeset)   ── after P1–P6
```
Same-file contention (builders, `index.ts`, query type files) means parallel groups run as
one agent or are sequenced; the graph marks logical independence, not safe concurrent writes.

## Phase 1 — `lower()` free function; retire public `build()`
Tasks:
- Create `src/queries/lower.ts`: `lower(query)` overloaded — select →
  `buildSelectQuery(query.toRawInput())`; create/update/delete → move the bodies of the
  builders' current `build()` here (the factory + `buildCanonical*` calls).
- Make `QueryBuilder.toRawInput()` (and the mutation builders' equivalent state access)
  reachable by `lower()` without `lower` importing the IR pipeline *through* the builder;
  remove `build()` from all four builders. Confirm `QueryBuilder` no longer imports
  `IRPipeline` (grep).
- Update in-repo `build()` callers (tests, `QueryBuilder.exec` temporarily) to `lower()`.

Validation:
- `npx tsc -p tsconfig-cjs.json --noEmit` = 0; grep proves no `IRPipeline` import from
  `QueryBuilder.ts`.
- Test `src/tests/lower-parity.test.ts` — `lowerParity` cases: for `createSimple`,
  `updateAddRemoveMulti`, `deleteMultiple`, `Person.select(['name']).where(...).limit(20)`
  assert `lower(builder)` deep-equals the IR captured from the pre-change `build()` golden
  (reuse `sanitize`). Assert select IR has `kind:'select'`, mutation IR has correct `kind`.

## Phase 2 — Rename + closed-query contract + exec + routing  (after P1)
Tasks:
- **Rename** `QueryBuilder` → `SelectBuilder` (file `SelectBuilder.ts`, class); keep a
  **deprecated `QueryBuilder` alias export**; update `Shape.select`, tests, `index.ts`.
- Make `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` **closed read-only interfaces**
  (`toJSON()`, `readonly shape`, `toRawInput()`/description hook — **no mutators, no `exec()`**)
  implemented by the builders. Add `SelectQueryJSON`(=`QueryBuilderJSON`) + `*MutationJSON`
  aliases. Add the `LinkedQuery` umbrella interface (`toJSON`/`shape`/`exec`).
- Migrate the ~23 IR-meaning `SelectQuery`/`*Query` references → `IRSelectQuery`/`IR*Mutation`
  (enumerate via `grep -rn 'SelectQuery' src --include=*.ts`).
- `IDataset` keeps `selectQuery(query: SelectQuery)` (now the closed interface) — **signature
  unchanged**. `queryDispatch`/`LinkedStorage` typed to the closed `*Query`; routing reads
  `query.shape` (add a `shape` getter if absent) instead of `query.root.shape`; update the
  validity check.
- Builder `exec()` dispatches `this` (received by the dataset as the closed `*Query`).

Validation:
- typecheck 0; `store-routing.test.ts`: a recording `IDataset` receives the closed query,
  routes by shape, and `lower(received)` equals `lower(original)`. Cases: select default,
  select `.for(id)`, create, update `.forAll()`, delete `.all()`. Assert the dataset gets the
  **same instance** (`received === original`, no rebuild) and that `(received as any).where`
  is undefined at runtime is NOT required — closure is type-level (compile-time check that
  `received.where` is a type error).

## Phase 3 — `SparqlDataset` lowers internally  (after P2)
Tasks:
- `SparqlDataset.{select,create,update,delete}Query(q)` → `const ir = lower(q)` then the
  existing `*ToSparql(ir, opts)` path. Remove IR-typed params.
Validation:
- `sparql-select-golden`, `sparql-mutation-golden`, `sparql-algebra` green unchanged;
  `sparql-fuseki` green when Docker present (else self-skips).

## Phase 4 — Mutation `fromJSON` (json → builder)  (after P1; ∥ P2)
Tasks:
- Add `static fromJSON` to `CreateBuilder`/`UpdateBuilder`/`DeleteBuilder` reconstructing
  builder state from the `*MutationJSON`: shape via `resolveShape`, data via a new
  `decodeNodeDataToUpdatePartial` (or reuse `decodeNodeData` + a description→UpdatePartial
  step) so `.set()` receives equivalent input; restore mode/targetId/ids/where
  (`deserializeWherePath`).
- Export the new `fromJSON`s.

Validation:
- Extend `mutation-serialization.test.ts`: `builder round-trip` — for every existing case,
  `lower(Builder.fromJSON(b.toJSON()))` deep-equals `lower(b)` (sanitized). Add explicit
  cases: update `where`, update `forAll`, delete `all`, delete `where`, computed-expression
  update (multi-segment traversalPatterns survive).

## Phase 5 — Remove `RemoteDataset`; kind-detecting `fromJSON` + wire version  (after P2,P4)
Tasks:
- Delete `src/remote/RemoteDataset.ts`, `RemoteClient.ts`, `RemoteProtocol.ts`,
  `remote/index.ts`, `src/tests/remote-dataset.test.ts`; strip their exports from
  `src/index.ts`. **No `ForwardingDataset` / `receiveQuery` in core** (deferred).
- Add a **kind-detecting `fromJSON(json): LinkedQuery`** that routes by the envelope's `op`
  to `SelectBuilder.fromJSON` / the P4 mutation `fromJSON`s. The inbound boundary is then
  just `fromJSON(json).exec()` (uses the existing generic dispatch — no `op` param, no helper).
- Add top-level `v: "1.0"` to the wire envelope in `toJSON`; `fromJSON` rejects an unknown
  major version.

Validation:
- `src/tests/from-json-roundtrip.test.ts` — `fromJSON(q.toJSON())` yields a builder whose
  `lower()` equals `lower(q)` for select + each mutation kind (kind auto-detected from the
  envelope). Assert an unknown `v` major throws.

## Phase 6 — Query context as a first-class JSON value (all positions)  (after P2,P4)
Tasks:
- Define one context-ref JSON kind `{$ctx: name}` usable in **every** reference position:
  - **subject**: `SelectQueryJSON.subject` and mutation `targetId`/ids;
  - **where-args**: extend `serializeQueryArg`/`deserializeQueryArg`;
  - **mutation values**: extend `encodeValue`/`decodeValue` (`MutationValueJSON`).
- Stop eager-resolving in `toJSON`; always emit the `$ctx` ref for a `PendingQueryContext`.
- `UpdateBuilder.for(ctx)` / `DeleteBuilder` accept `PendingQueryContext` (mutation parity);
  store + serialize identically to select.
- Resolution moves into `lower()`: resolve every `$ctx` against the live context map; **throw**
  `UnresolvedContextError` if any is absent (replaces select's current "pending → exec null").
  Update `exec()` pending-guards accordingly.

Validation:
- `src/tests/query-context-json.test.ts` — for subject, where-arg, and mutation-value
  positions, across select + update + delete: (a) `$ctx` survives `toJSON↔fromJSON`;
  (b) `lower()` produces concrete-id IR when the context is set; (c) `lower()` throws
  `UnresolvedContextError` when unset. Cases incl.
  `.where(p => p.owner.equals(getQueryContext('me')))` and
  `Person.update({owner: getQueryContext('me')}).for(ctx)`.

## Phase 7 — Tree-shaking  (after P1,P2)
Tasks:
- Enumerate import-time side effects (`LinkedStorage` counter, `index.ts` `initModularApp`);
  either refactor them to lazy or set `package.json` `sideEffects` to the explicit list of
  files that must be kept.
Validation:
- `src/tests/treeshake-graph.test.ts` (static import-graph assertion) OR a documented bundle
  probe showing a `QueryBuilder` + `ForwardingDataset` entry excludes `queries/IRLower`,
  `queries/IRCanonicalize`, `sparql/*`.

## Phase 8 — Docs + versioning  (after P1–P6)
Tasks:
- NEW `documentation/dsl-json.md`: full spec — envelope (`op`, `v`, `shape`), select shape,
  mutation shapes, the `MutationValueJSON` kinds table, context `{$ctx}` refs, round-trip
  guarantee, "this is the wire format" framing.
- `README.md`: to/from JSON section + link to spec + `SparqlDataset` as reference store.
- Rewrite the store-implementer guide in `documentation/intermediate-representation.md`
  (builders in; IR via `lower()` optional; mapping table kept).
- Retire/replace `docs/reports/017` at wrapup; major-version changeset describing the
  breaking contract change + migration (`build()` → `lower()`; datasets receive builders).
Validation:
- Docs build/lint if present; manual check that every exported symbol in the contract is
  documented; changeset present.

## Implementation progress

- **Phase 1 — DONE (with deviation).** Added `src/queries/lower.ts` (free `lower(query)`,
  discriminates on `__queryKind`: select → `buildSelectQuery(toRawInput())`, mutations →
  builder `_toIR()`). `QueryBuilder` no longer imports `IRPipeline` (grep-verified). Added
  `__queryKind` to all four builders; mutation `build()` bodies renamed to internal `_toIR()`.
  Exported `lower`. New `src/tests/lower.test.ts`. Full suite 1175 passing.
  - **Deviation:** kept `build()` as a `@deprecated` alias delegating to `lower(this)` rather
    than removing it, to avoid churning ~50 `.build()` call sites across ~10 test files and
    hard-breaking external callers in one step. Consequence: the IR pipeline is still
    reachable from the builders via the deprecated `build()`, so the *full* tree-shaking win
    (Phase 7) is reduced to shedding the SPARQL layer unless `build()` is later removed. The
    free `lower()` is the canonical API going forward.

- **Phase 2 — DONE (3 sub-steps; Phase 3 + the remote deletion folded in).**
  - 2a: migrated IR-return usages to explicit `IR*Query` names (added `IRCreateQuery`/
    `IRUpdateQuery`/`IRDeleteQuery`).
  - 2b: renamed class `QueryBuilder` → `SelectBuilder` (deprecated `QueryBuilder` alias;
    `SelectBuilder` exported).
  - 2c: `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` are now **closed read-only
    interfaces** the builders implement (`__queryKind`, `shape` getter, `toJSON`,
    `toRawInput`/`_toIR`); `IDataset` signature unchanged. `exec()` dispatches the builder;
    `LinkedStorage` routes by `query.shape` (NodeShape) via an extended
    `resolveDatasetForQueryShape`. **`SparqlDataset` now calls `lower(query)` internally
    (Phase 3 folded in).** `MutationSerialization.lowerMutationJSON` + the factories return
    `IR*Query`. **Deleted `src/remote/*` + `remote-dataset.test.ts` (Phase 5 deletion pulled
    forward to avoid type conflicts); stripped remote exports.**
  - Test-contract fallout fixed: `query-capture-store` now `lower()`s captured queries;
    `store-routing`/`core-utils`/`shacl-syncshapes`/`sparql-fuseki`/`ir-select-golden` updated
    to the builder contract / `IRSelectQuery` typing.
  - Validation: typecheck 0; full suite **1169 passing**, 0 failing.

- **Phase 4 — DONE (+ kind-detecting fromJSON from Phase 5).** Added `decodeNodeDataToRaw`
  (JSON → raw `UpdatePartial`) to `MutationSerialization`. Added a `_where?: WherePath`
  state field to `UpdateBuilder`/`DeleteBuilder` (+ constructor/clone/where-build/toJSON
  paths) so `where`-mode can rehydrate a deserialized path (not a callback). Added
  `static fromJSON` to `CreateBuilder`/`UpdateBuilder`/`DeleteBuilder`. Added kind-detecting
  free `fromJSON(json)` (`src/queries/fromJSON.ts`) routing by the envelope `op`, exported
  from index. New round-trip tests: `lower(Builder.fromJSON(wire(b.toJSON()))) ≡ lower(b)`
  and via the umbrella `fromJSON`, across create/update(for/forAll/where)/delete(ids/all/where)
  incl. date, computed expression, nested-with-id, set add/remove. Full suite **1180 passing**.

- **Phase 5 — DONE.** (Remote deletion landed in Phase 2.) Added `src/queries/wireVersion.ts`
  (`WIRE_VERSION='1.0'` + `assertWireVersion`). Every `toJSON` envelope (select + mutations)
  now carries `v:'1.0'`; the kind-detecting `fromJSON` rejects an unknown major (missing `v`
  tolerated). Full suite 1181 passing.

- **Phase 6 — PARTIAL (mutation subject-context parity).** Added `UnresolvedContextError`
  (`QueryContext.ts`). `UpdateBuilder.for()` now accepts a `PendingQueryContext`; the context
  ref is carried in DSL-JSON as `targetContext` (round-trips via toJSON/fromJSON) and is
  **resolved at lowering time** against the live context map — throwing `UnresolvedContextError`
  if unset (the "resolve-at-lower / throw" semantics, for mutations). Full suite 1182 passing.
  - **DEFERRED (remaining Phase 6 scope):** context refs in **where-args** and **mutation
    field-values**; **delete-by-context**; and unifying **select** subject-context to the same
    resolve-at-lower-throw semantics (select currently keeps its existing `pendingContextName`
    + silent-null behavior). These are a larger, cohesive pass best done together.
- **Phase 7 — DEFERRED (gated).** A safe `sideEffects` flag needs an exhaustive import-side-effect
  audit (ontologies/expressions have module-level statements), and the actual tree-shaking win
  is **blocked until `build()` is removed** (the IR pipeline stays reachable from every builder
  via the deprecated `build()`). Best done together with the `build()` removal at wrapup.

- **Reactivity primitive (enabler for context "wait"/"re-resolve").** Added
  `subscribeQueryContext(listener)` to `QueryContext`; `setQueryContext` now notifies
  subscribers on set/clear. This is the core hook the React/component layer uses to re-run
  affected queries when a context lands (so unresolved → `null` locally, then re-runs and
  resolves on the change) — re-execution itself stays in the consumer layer. Exported
  `getQueryContext`/`setQueryContext`/`subscribeQueryContext`/`PendingQueryContext`/
  `UnresolvedContextError` from the barrel. Full suite 1183 passing.
