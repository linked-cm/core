---
summary: Chapter 3 of the repo analysis (report 022 §3) — resolved the catalogued inconsistencies and functional gaps (G1–G14, Tier 4/5) in @_linked/core. Highlights: correct SPARQL operator precedence, a reconciled and LLM-authorable DSL-JSON wire format (relation-keyed projection, word-operator aliases, `oneOf`/`notOneOf` membership, `@`-sigiled value-tags), mutation-input correctness, per-path multi-key sort, `SetSize` comparisons, SHACL constraint serialization, a trimmed `Expr` module, SHACL path guards, and a coherent throw-vs-warn error policy with lightweight structural write-validation.
source_report: docs/reports/022-repo-analysis-cleanup-security-gaps.md (section 3)
packages: [core]
---

# 025 — Inconsistencies & Gaps (Chapter 3)

Third chapter of the repo-wide analysis (report 022). Chapters 1 (leanness → report 023) and 2 (security → report 024) preceded this. Worked under a fixed discipline: **valid input stays byte-identical; every fix gets a lock-in test; existing tests change only with sign-off.** Gate on each phase: `npm test` (jest + `tsc` typecheck). Final suite: **1460 passed / 117 skipped**, typecheck green.

## Outcome by gap

### Tier 1 — silent wrong results / broken primary docs

**G1 — SPARQL operator precedence.** `algebraToString` emitted `binary_expr` as `left op right` with no grouping, so `plus(a,b).times(c)` produced `?a + ?b * ?c` (parsed `a+(b*c)` — silently wrong numbers) and comparison-in-comparison produced a syntax error. Added precedence-aware parenthesization (`*`/`/` = 3, `+`/`-` = 2, relational = 1): wrap a left child when `prec(child) < prec(parent)`, a right child when `<=` (left-associativity), always wrap relational-in-relational (non-associative) and any `logical_expr` child. All pre-existing golden output stayed byte-identical (no fixture nested a `binary_expr`). Lock-ins in `sparql-serialization.test.ts`.

**G2 — DSL-JSON spec ↔ decoder drift.** `documentation/dsl-json.md` (the canonical wire format + LLM-authoring target) documented grammar the decoder rejected or mis-read. Because nothing persists the wire format yet, the format was reshaped freely toward one short, unambiguous, LLM-friendly grammar. Four locked decisions, delivered in phases:
- **Spec-conformance harness** — `dsl-json-spec-fixtures.ts` (source of truth) + `dsl-json-spec.test.ts` drive documented JSON examples through `fromJSON → lower → SPARQL`, so the doc and codec cannot silently drift.
- **Word-operator aliases** — `equals`/`notEquals`/`gt`/`gte`/`lt`/`lte` accepted as input sugar alongside the canonical symbols (`=`/`!=`/…), fixing the prior silent-wrong decode of `{name:{equals:"x"}}`. Encoder still emits symbols.
- **Relation-keyed projection is the single canonical form** — `FieldSet.toJSON`/`fromJSON` rewritten to three unambiguous shapes: string leaf, `{ "<rel>": [...] | {as?,where?,one?,cast?,fields} }`, and computed `{as,value}`. The path-keyed `{path,subSelect}` spelling and the redundant nested `shape` (inferred from `valueShape`) were dropped; casts ride inline in the key (`{ "pets": {cast:"Dog", fields} }`).
- **Membership `oneOf`/`notOneOf`** — new feature end-to-end (IR `in_expr` → SPARQL `IN`/`NOT IN`, empty-list constant-folded to `false`/`true`). Names chosen as an obvious matched pair (negation reads "is not one of"); elements are literals or `{@id}` refs following the property type; lives in `where`/`.some()`/`.every()`, resolves to a filter. Value-∈-subquery and set-to-set membership deferred (backlog 010).

**G4 — computed expressions silently dropped in `create`.** `create` lowers to `INSERT DATA` (ground triples, no `WHERE`), where an expression can't be evaluated — so `fieldValueToTerms` silently returned `[]`, dropping the field. Now throws a clear error (use a literal, or `update`). The feature that would make computed/subquery `create` values *work* (via `INSERT … WHERE`) is captured in backlog 011.

### Tier 2 — crashes / silent loss on valid-looking input

- **G6** — `isSetModificationValue(null)` threw `TypeError` (`typeof null === 'object'` → `null.$add`); guarded `value === null` (null → unset, matching the builder path).
- **G7** — `isSetModification` short-circuited its key-count check, so `{add:[…], name:'x'}` was misclassified and `name` silently dropped. Fixed to `(hasAdd || hasRemove) && numKeysExpected === numKeys`.
- **G9** — multi-key sort collapsed `[{name:'ASC'},{age:'DESC'}]` to the first direction. `SortByPath`/`DesugaredSortBy` now carry per-path `directions[]`, threaded through desugar/lower/serialize; the wire round-trips mixed directions.
- **G10** — nested-select pagination (`limit`/`offset`/`orderBy` on a relation) lowered to SPARQL but was never emitted by `FieldSet.toJSON`, so serialize→rehydrate silently returned the unbounded set. Now serialized and re-parsed. `nested-pagination-wire.test.ts` locks it.
- **G8** — see the dedicated section below.

### Tier 3 — feature asymmetries

- **G3** — implemented-up the documented root API: added `export {Shape}` and `export {LinkedStorage}` to `index.ts`; corrected README (`setDefaultStore`→`setDefaultDataset`, `setStoreForShapes`→`setDatasetForShapes`); added the `"./sparql"` package export so `@_linked/core/sparql` resolves.
- **G5** — SHACL value-range/length/pattern constraints (`minInclusive`/`maxInclusive`/`minExclusive`/`maxExclusive`/`minLength`/`maxLength`/`pattern`) were declared in the config type and ontology but never read or serialized. Wired end-to-end (serialization only; **no DSL-side runtime enforcement** — the store validates): `createPropertyShape` reads them, `getResult()` exposes them (pattern as its regex source string), `buildPropertyShapeData` emits them to the sync create-data, and `Package.ts` adds the `sh:` accessors so labels resolve to predicates. Language constraints (`languageIn`/`uniqueLang`) skipped.
- **G11** — `SetSize` gained `gt/gte/lt/lte/neq` (+ long aliases) via a shared `toCountExpr()` → `HAVING(count(…) <op> n)`, so `.size().gt(2)` works (was `.equals()`-only). The `sum/avg/min/max` aggregate DSL surface remains backlog 006.
- **G12** — the `Expr` static module had drifted from its charter (report 010: non-property-first ops only) into a **full mirror** — 50 of 55 functions were one-line delegators to the identical fluent method, two under a *different* name (`Expr.regex`→`.matches`, `Expr.bound`→`.isDefined`). **Trimmed to the five ops with no natural fluent host:** `now`, `ifThen`, `firstDefined`, `concat` (variadic; the common literal-first case), `not` (prefix negation). The fluent form (`p.age.plus(1)`, `p.name.matches(/^A/)`, `p.hobby.oneOf([…])`) is the one true way for everything property-first. This **erases the naming drift by removal** and settles "missing `Expr.oneOf`" by keeping membership fluent-only.
- **G13** — SHACL paths. (1) A negated property set still throws at sync — SHACL genuinely has no `sh:path` representation; deliberate, clear error. (2) Added guards to `serializePathToNodeData`: a 1-member `seq`/`alt` collapses to its bare member, an empty one throws, per SHACL §2.3.1/§2.3.2 (a sequence/alternative is a list of ≥2). Backend-only (`syncShapes` path). (3) The reverse `sh:path`→`PathExpr` reader (bidirectional shape sync) is a genuine feature deferred to backlog 030 (the write side already shipped in report 016).
- **G14** — moot: the always-throwing stubs it flagged (`ShapeClass` throw-only functions) were already deleted as dead code in chapter 1 (report 023).

### Tier 4/5 — error-handling policy + write validation

Reconstructed the report's unwritten catalogue against the code (117 `throw` vs 10 `console.warn`; the real issue was the *same failure class* getting opposite treatment by module). **Policy:** `throw` = caller logic error (default); `warn`-once = recoverable environment/bundling condition only; `silent` ≈ never — because a library `console.warn` is effectively silent (swallowed console), warning-and-limping on a logic error is the anti-pattern the library's own "silent wrong results are worst" principle forbids.

- **Two warn→throw flips** (the genuine silent-wrong traps): accessing an **undecorated property in a query** (both the single-node `QueryShape` and set-valued `QueryShapeSet` proxies — the latter fixed during review, see below) now throws instead of returning a broken path; `setQueryContext` with an unrecognized value or a `{id}` without a shapeType now throws instead of a silent no-op. The query-proxy throw is guarded by a shared `INTEROP_PASSTHROUGH_KEYS` set (`then`/`$$typeof`/`toJSON`/…) plus symbol passthrough, so promise/React/serializer introspection is unaffected.
- **Lightweight structural write-validation** (`validateAgainstShape` in `MutationQuery.createNodePropertyValue`, covering top-level **and** nested descriptions): **min/maxCount** (value count within cardinality; clearing a `minCount≥1` property with `null` or `[]` both throw) and **node kind** (a literal property given a `{@id}`/object, or a relation property given a bare scalar, throws; ambiguous kinds like `IRIOrLiteral` unenforced). Skips expressions, context refs, and set-modifications (final count/kind unknowable there). Structural only — it does not duplicate the store's datatype/deep validation.
- Full data validation intentionally not added (the store validates; keeps the library lean). The ergonomic fix for plain-object update under a shapeless property (a typed builder value) is backlog 013.

## The DSL-JSON `@`-sigil wire-format change (G8)

The seven system value-tags used bare keys (`$ctx`, `id`, `date`, `list`, `add`/`remove`, `unset`, `path`) that collided with user property labels of the same name in **value position** — a shape could not have a property literally named `date`/`id`/`path`/…. All seven are now `@`-sigiled:

| Old | New | Meaning (value position only) |
|---|---|---|
| `{$ctx}` | `{@ctx}` | query-context reference (+ `@path` for a sub-access) |
| `{id}` | `{@id}` | node reference |
| `{date}` | `{@date}` | a `Date` (ISO string) |
| `{list}` | `{@list}` | a list (multi-valued) |
| `{add}`/`{remove}` | `{@add}`/`{@remove}` | set add/remove on a relation |
| `{unset}` | `{@unset}` | clear a property |
| `{path}` | `{@path}` | a property used as a value / computed path |

**Decision:** the `@` namespace can never collide with a user label because the tags appear only in value position; structural node-data keys stay `__id`/`__shape` (a *different axis* — record-metadata alongside labels, not a typed-value envelope — confirmed to keep). Done now while nothing persists the wire format. The round-trip conformance suite proved encode/decode symmetry through the change; only exact-wire-shape assertions were updated (wire positions → `@`-tags; DSL-API call positions like `.for({id})` unchanged). `documentation/dsl-json.md` and `dsl-json-llm-prompt.md` were both migrated (the prompt doc during review — it had been missed).

## Public API / behavior changes users should know

- **New DSL:** `.oneOf(list)` / `.notOneOf(list)` membership on any query property (→ SPARQL `IN`/`NOT IN`); `.size().gt(n)` (and `gte/lt/lte/neq`) on set-size; per-path directions in multi-key `sortBy`.
- **New exports:** `Shape`, `LinkedStorage`, and the `@_linked/core/sparql` subpath.
- **SHACL:** value-range/length/pattern constraints now serialize into synced shapes.
- **Breaking — `Expr` trimmed:** the ~50 delegator methods (`Expr.plus`/`eq`/`matches`/`regex`/`bound`/…) were removed; use the fluent form (`p.age.plus(1)`). `Expr` keeps only `now`/`ifThen`/`firstDefined`/`concat`/`not`.
- **Behavior — stricter, louder:** accessing an undecorated property inside a query callback now throws (it previously warned and returned a garbage constant — it never worked); `setQueryContext` with an unmaterializable value throws; create/update reject cardinality and literal-vs-relation kind violations at normalize time.
- **Wire format:** the `@`-sigil tags above (no released consumer persists the old format).

## Test coverage added

`sparql-serialization` (G1 precedence), `dsl-json-spec` + `dsl-json-spec-fixtures` (G2 doc-conformance harness), `one-of` (membership), `mutation-input-fixes` (G4/G6/G7), `sort-and-aggregate` (G9/G11), `nested-pagination-wire` (G10), `reserved-value-tags` (G8 label-collision lock-in), `shacl-constraint-serialization` (G5), `shacl-path-translator` (G13 guards), `mutation-shape-validation` (Tier 4/5 cardinality + node-kind + null-clears-required + nested + ambiguous-kind), `query-builder` (undecorated-property throw, single and set-valued), `core-utils` (setQueryContext throws), plus updated round-trip / format-assertion suites throughout.

## Review findings (all resolved)

A three-agent parallel review confirmed the code correct and surfaced seven gaps, all fixed: the error-policy hole where only the single-node proxy threw (the set-valued `QueryShapeSet` proxy now throws too, via the shared interop set); the stale `dsl-json-llm-prompt.md` (migrated); `WIRE_TAG` being 7/8 dead (trimmed to a single `CONTEXT_REF_KEY`); stale `{$ctx}`/`{path}` code comments (migrated); missing tests (added); and the `null`-vs-`[]` clear asymmetry (unified to throw). Details in the review section of the (removed) plan; captured here as resolved.

## Deferred work (backlog / ideas)

- **006** — DSL aggregates `sum`/`avg`/`min`/`max` (IR/SPARQL already support; ~5 edits).
- **008** — SEC4 property-path prefixed-name grammar validation (SEC6 resolved inline).
- **009** — false-green Fuseki CI suites (skip/fail without Docker).
- **010** — membership rungs 2–4 (subquery / set-to-set → `EXISTS`/anti-join).
- **011** — `create` with computed / subquery-derived values (`INSERT … WHERE`).
- **013** — typed builder/`Shape` values for shapeless-property writes.
- **030** — SHACL `sh:path`→`PathExpr` reader (G13 read side; the write side shipped in report 016).

## Related documentation

- `documentation/dsl-json.md` — the canonical wire-format contract (updated).
- `documentation/dsl-json-llm-prompt.md` — LLM-authoring system prompt (updated).
- `documentation/intermediate-representation.md` — the IR the codecs lower to.
- `docs/reports/022-...` (analysis), `023-...` (chapter 1 leanness), `024-...` (chapter 2 security).
