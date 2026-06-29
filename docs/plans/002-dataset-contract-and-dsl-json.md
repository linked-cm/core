---
summary: Flip the dataset contract so datasets receive the live linked query object (the builder); make DSL-JSON the wire/interop format produced on demand at boundaries; make the IR an opt-in store detail behind a free lower() function (no public .build()); add mutation fromJSON; remove the RemoteDataset adapter; make query context a first-class JSON value with mutation parity; document the JSON spec; enable tree-shaking. Major version.
packages: [core]
status: Tasks
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

## Chosen route (Option 1 + interface hedge)

Datasets receive the **live builder**. The inbound boundary of any process rehydrates
incoming JSON → builder once (`fromJSON`), then everything internal is a builder
(routing introspects the builder; stores `lower()` it or read it directly).

**Rejected — Option 2** (`LinkedQuery` interface + `JsonBackedQuery` wrapper +
per-dataset `toBuilder()`): its only real win is a free content-blind JSON→JSON relay,
which never triggers in an inspect-to-route architecture; it adds `toBuilder()` ceremony
to every dataset. We keep the door open cheaply by typing the contract as a thin marker
interface the builder implements, so `JsonBackedQuery` can be added later non-breaking if a
transparent-relay use case appears.

## Three-tier naming

| Tier | Type (new) | Was | Role |
|---|---|---|---|
| Live query | `SelectQuery` = `QueryBuilder` (impl. `LinkedSelectQuery`) | alias of IR | what datasets receive |
| Wire | `SelectQueryJSON` (= today's `QueryBuilderJSON`) | n/a | crosses boundaries |
| Algebra | `IRSelectQuery` (unchanged) | `SelectQuery` | optional store lowering target |

Same pattern for `CreateQuery`/`UpdateQuery`/`DeleteQuery` (live = the mutation builders;
wire = the `*MutationJSON` types; algebra = `IRCreate/Update/DeleteMutation`).

## Inter-component contracts

```ts
// IDataset — receives the live query object
interface IDataset {
  selectQuery(query: SelectQuery): Promise<SelectResult>;          // SelectQuery = QueryBuilder
  createQuery?(query: CreateQuery): Promise<CreateResult>;         // CreateQuery = CreateBuilder
  updateQuery?(query: UpdateQuery): Promise<UpdateResult>;
  deleteQuery?(query: DeleteQuery): Promise<DeleteResponse>;
}

// Thin marker interface the builders implement (the "hedge")
interface LinkedSelectQuery {
  toJSON(): SelectQueryJSON;
  readonly shape: NodeShape;     // for routing without forcing a lower()
}

// IR lowering — a FREE function (tree-shaking boundary), not a method
function lower(query: SelectQuery): IRSelectQuery;
function lower(query: CreateQuery): IRCreateMutation;
// …overloaded per kind. Replaces the public builder.build().

// Mutation fromJSON (new) — inverse of the existing toJSON codec
CreateBuilder.fromJSON(json: CreateMutationJSON): CreateBuilder;
UpdateBuilder.fromJSON(json: UpdateMutationJSON): UpdateBuilder;
DeleteBuilder.fromJSON(json: DeleteMutationJSON): DeleteBuilder;
```

A store consumes whichever projection it wants:

```ts
class SparqlDataset {
  selectQuery(q: SelectQuery) { return run(selectToSparql(lower(q), this.options)); }
}
class InMemoryDataset {
  selectQuery(q: SelectQuery) { /* read q directly, or lower(q) — its choice */ }
}
abstract class ForwardingDataset {
  selectQuery(q: SelectQuery) { return this.send(q.toJSON()); }   // toJSON only at the wire
}
```

## Files expected to change

| Area | Files | Change |
|---|---|---|
| Lowering | NEW `src/queries/lower.ts`; `QueryBuilder.ts`, `*Builder.ts` | add free `lower()`; remove public `build()`; expose internal raw-input/factory access for `lower()` |
| Naming | `SelectQuery.ts`, `CreateQuery.ts`, `UpdateQuery.ts`, `DeleteQuery.ts`, ~23 IR-consuming files | repoint `SelectQuery` etc. to the builder; switch IR-meaning uses to `IRSelectQuery` |
| Contract | `interfaces/IDataset.ts`, `queries/queryDispatch.ts`, `utils/LinkedStorage.ts`, `QueryBuilder.exec` | datasets receive builder; `exec()` dispatches the builder; route by `query.shape` |
| SPARQL | `sparql/SparqlDataset.ts` | call `lower()` internally |
| Mutation rehydrate | `CreateBuilder.ts`, `UpdateBuilder.ts`, `DeleteBuilder.ts`, `MutationSerialization.ts` | add `fromJSON` (json → builder) |
| Remove adapter | `src/remote/*` (4 files) + `remote-dataset.test.ts` | delete |
| Forwarding (optional) | NEW `src/datasets/ForwardingDataset.ts`, inbound `receiveQuery(json)` helper | reusable transport bases |
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

## Phases

### Phase 1 — `lower()` free function; retire public `build()`
- Add `src/queries/lower.ts` exporting `lower(query)` (overloaded select + mutation).
  Select: `buildSelectQuery(query.toRawInput())`; mutations: the current factory/IR builder
  logic moved out of the builders.
- Remove public `build()` from all builders; expose the minimal internal hooks `lower()`
  needs (raw-input / description). Ensure `QueryBuilder` no longer imports `IRPipeline`.
- **Validation:** typecheck exits 0; new `lower-*.test.ts` asserts `lower(builder)` equals
  the old `build()` IR for representative select + mutation fixtures (golden parity).
- Depends on: none. **Blocks 2, 3, 7.**

### Phase 2 — Contract flip + naming + exec + routing
- Repoint `SelectQuery`/`CreateQuery`/`UpdateQuery`/`DeleteQuery` to the builders; add
  `LinkedSelectQuery` (+ mutation markers) implemented by the builders; migrate ~23
  IR-meaning references to `IRSelectQuery`/`IR*Mutation`.
- `IDataset`, `queryDispatch`, `LinkedStorage` typed to the builder; routing reads
  `query.shape`. `QueryBuilder.exec()` dispatches `this`.
- **Validation:** typecheck 0; `store-routing.test.ts` updated and green; a fake dataset
  receives a builder and can `lower()` it.
- Depends on: 1. **Blocks 3, 5, 6.**

### Phase 3 — `SparqlDataset` lowers internally
- `SparqlDataset.{select,create,update,delete}Query` call `lower(query)` then the existing
  `*ToSparql`. IR becomes a SPARQL detail.
- **Validation:** existing `sparql-*-golden` + `sparql-fuseki` (when Docker present) green
  unchanged.
- Depends on: 1, 2.

### Phase 4 — Mutation `fromJSON` (json → builder)
- Add `fromJSON` to `CreateBuilder`/`UpdateBuilder`/`DeleteBuilder`, reusing `decodeNodeData`
  + `deserializeWherePath`. Reconstructs builder state (data, mode, targetId/ids, where).
- **Validation:** extend `mutation-serialization.test.ts` with builder round-trip:
  `fromJSON(b.toJSON())` then `lower(...)` ≡ `lower(b)` for every feature.
- Depends on: 1 (lower), codec (exists). Independent of 2/3. **Needed by 5, 6.**

### Phase 5 — Remove `RemoteDataset`; add transport bases
- Delete `src/remote/*` + `remote-dataset.test.ts`.
- Add `ForwardingDataset` (abstract: builder → `toJSON()` → `send(json)` → deserialize
  result) and an inbound `receiveQuery(json) → builder` helper that rehydrates and hands to
  dispatch. (Confirm scope: ship in core vs leave to backend repos.)
- **Validation:** new `forwarding.test.ts` — a `ForwardingDataset` whose `send` loops back
  through `receiveQuery` into a recording dataset delivers a builder whose `lower()` equals
  the original.
- Depends on: 2, 4.

### Phase 6 — Query context as a first-class JSON value (+ mutation parity)
- Define a context-ref JSON encoding usable in **every** reference position: subject
  (`.for`), where-args, and mutation field values.
- Stop eager-resolving at `toJSON`; carry the ref. Resolve at lowering against the available
  context map; **throw** if unresolvable. Replace select's "pending → null" with the throw.
- Add context support to mutations: `UpdateBuilder.for(context)` etc., mirroring select.
- **Validation:** `query-context-json.test.ts` — context ref survives toJSON↔builder; resolves
  to concrete IR when the context is set; throws when not; mutation context parity.
- Depends on: 2, 4. Largest phase; may run as its own ideation→tasks sub-cycle.

### Phase 7 — Tree-shaking
- Audit/annotate import-time side effects (`LinkedStorage`, `index.ts`); add `sideEffects`
  to `package.json` so a client not importing `lower()`/`SparqlDataset` drops the IR+SPARQL
  pipeline.
- **Validation:** a bundle-size probe (or import-graph assertion) showing a select-only +
  forwarding client excludes `IRLower`/`sparql/*`.
- Depends on: 1 (lower free fn), 2 (exec no longer calls build).

### Phase 8 — Docs + versioning
- NEW `documentation/dsl-json.md` — full DSL-JSON spec (every op, value kinds, context refs,
  optional `version` field TBD), with the round-trip and "this is the wire format" framing.
- `README.md` — section on to/from JSON, the wire format, link to the spec, and a pointer to
  `SparqlDataset` as the reference store that lowers through the shape-resolved IR.
- Rewrite the store-implementer guide in `intermediate-representation.md` (builders in, IR
  via `lower()` optional). Replace/retire report 017.
- Major version changeset.
- Depends on: 1–6 landed.

## Dependency graph
```
1 ─┬─ 2 ─┬─ 3
   │      ├─ 5 ── (needs 4)
   │      └─ 6 ── (needs 4)
   ├─ 4 ──┘
   └─ 7   (needs 1,2)
8 last (needs 1–6)
```
Phase 6 (context) is large and orthogonal — candidate for its own ideation/tasks sub-cycle.

## Resolved decisions
1. **Name = `lower(query)`** (confirmed).
2. **Ship `ForwardingDataset` + `receiveQuery` in core** as reference transport bases —
   *pending user confirmation after context (below).*
3. **Context = all positions at once** (confirmed): subject `.for()`, where-args, and
   mutation values in one Phase 6 (no 6a/6b split).
4. **DSL-JSON format version = `"1.0"`, shipped now** as top-level `v` on the wire envelope
   (confirmed). NOTE: this is the *wire-format* version; the npm package bump for this
   breaking change is a separate question — see "Versioning note".
5. **Contract type (builder vs marker interface)** — *pending user confirmation after
   context (below); current lean: concrete builder.*

### Versioning note
`@_linked/core` is at **2.9.0**. The breaking contract change is a **major** bump → **3.0.0**.
"Version 1.0" was about the DSL-JSON wire format (`v:"1.0"`), not the package — confirm we
keep the package on the 2.x→3.0.0 line (a literal package `1.0.0` would be a downgrade).

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
P5 (remove remote + transport)    ── after P2,P4
P6a/P6b (context)                 ── after P2,P4     [P5 ∥ P6]
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

## Phase 2 — Contract flip + naming + exec + routing  (after P1)
Tasks:
- Repoint type aliases: `SelectQuery = QueryBuilder` (impl `LinkedSelectQuery`),
  `CreateQuery = CreateBuilder`, `UpdateQuery = UpdateBuilder`, `DeleteQuery = DeleteBuilder`.
  Add `SelectQueryJSON = QueryBuilderJSON` (+ mutation `*MutationJSON` aliases). Keep
  `IRSelectQuery`/`IR*Mutation` as the algebra names.
- Add `LinkedSelectQuery`/`LinkedCreateQuery`/… interfaces (`toJSON()`, `readonly shape`);
  builders `implements` them.
- Migrate the ~23 IR-meaning `SelectQuery` references → `IRSelectQuery` (and mutation
  equivalents). Enumerate via `grep -rn 'SelectQuery' src --include=*.ts`.
- `IDataset`, `queryDispatch.QueryDispatch`, `LinkedStorage` typed to the builder; routing
  reads `query.shape` (add a `shape` getter to builders if absent) instead of
  `query.root.shape`; update the validity check.
- `QueryBuilder.exec()` and mutation `exec()` dispatch `this` (the builder), not `lower()`.

Validation:
- typecheck 0; `store-routing.test.ts` updated: a recording `IDataset` receives a *builder*,
  routes by shape, and `lower(received)` equals `lower(original)`. Cases: select default,
  select `.for(id)`, create, update `.forAll()`, delete `.all()`.

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

## Phase 5 — Remove `RemoteDataset`; add transport bases  (after P2,P4)
Tasks:
- Delete `src/remote/RemoteDataset.ts`, `RemoteClient.ts`, `RemoteProtocol.ts`,
  `remote/index.ts`, `src/tests/remote-dataset.test.ts`; strip their exports from
  `src/index.ts`.
- Add `src/datasets/ForwardingDataset.ts` (abstract): `selectQuery(q)=>this.dispatch('select', q.toJSON())`, etc.; abstract `send(op, json): Promise<result>`; deserialize result.
- Add `src/datasets/receiveQuery.ts`: `receiveQuery(op, json) → builder` (select via
  `QueryBuilder.fromJSON`, mutations via the P4 `fromJSON`s) for the inbound boundary, and a
  thin `handleIncoming(envelope) → LinkedStorage.<op>Query(builder)` helper.
- Add the `v` version field to the wire envelope produced by `toJSON`/consumed by `fromJSON`
  (reject unknown major).

Validation:
- `src/tests/forwarding.test.ts` — a `ForwardingDataset` whose `send` loops back through
  `receiveQuery` into a recording `IDataset`: assert the delivered builder's `lower()` equals
  the original builder's `lower()`, for select + each mutation. Assert unknown `v` major →
  throws/structured error.

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
