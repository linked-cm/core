---
summary: Chapter 3 of report 021 — inconsistencies & functional gaps. Fix the highest-impact items under the established "keep tests green + add lock-in tests" discipline, starting with G1 (arithmetic operator precedence in SPARQL serialization). G2+ explored in ideation before committing.
status: Implementation
source_report: docs/reports/021-repo-analysis-cleanup-security-gaps.md (section 3)
packages: [core]
---

# 003 — Inconsistencies & Gaps (Chapter 3)

Constraint (unchanged): valid input stays byte-identical; new lock-in tests; existing tests changed only with sign-off. Gate: `npm test` (jest + typecheck).

## Candidate gaps (from report 021 §3, ranked)
- **G1** arithmetic precedence — `binary_expr` serialized without parens → `a+b*c` mis-groups. **Silently wrong numbers.** ← implement first.
- **G2** DSL-JSON spec vs decoder drift — documented grammar the codec rejects/mis-reads. ← explore (ideation) next.
- **G4** computed expressions silently dropped in `create` (work in `update`).
- **G6/G7** wire `null` crash / `isSetModification` precedence drops sibling fields.
- **G9** multi-key sort collapses to first direction.
- **G11** aggregates `sum/avg/min/max` + `SetSize` comparisons not exposed in DSL (IR/SPARQL already support).
- **G12/G13** `Expr` vs `ExpressionNode` drift; SHACL path parse ≠ serialize ≠ read-back.

## Phase 1 — G1: arithmetic operator precedence  ✅ DONE
Result: `wrapBinaryOperand` added to `algebraToString`; 6 lock-in tests in `sparql-serialization.test.ts`. Full suite 1452 (+6) / typecheck green; all pre-existing golden output byte-identical (no fixture had nested `binary_expr`).

### Diagnosis
`algebraToString.ts` `binary_expr` emits `${left} ${op} ${right}` with no grouping. Only `logical_expr` (OR-inside-AND) and `not_expr` parenthesize. So a nested `binary_expr` operand loses precedence:
- `Expr.plus(a,b).times(c)` → `?a + ?b * ?c`, parsed as `a + (b*c)` — **wrong**.
- comparison-in-comparison (`(a=b)=c`) → `?a = ?b = c` — SPARQL **syntax error** (relational is non-associative).

Existing golden tests only have `logical_expr` wrapping comparisons (e.g. `= "Moa" && = "Jogging"`) and comparisons over var/literal/function operands — **no `binary_expr`-in-`binary_expr`** — so a precedence-aware fix leaves all current output byte-identical.

### Fix
Precedence-aware parenthesization of `binary_expr` operands only:
- precedence: `*` `/` = 3; `+` `-` = 2; relational (`=` `!=` `<` `>` `<=` `>=`) = 1.
- wrap **left** child (a `binary_expr`) if `prec(child) < prec(parent)`.
- wrap **right** child if `prec(child) <= prec(parent)` (left-associativity: `a-(b-c)`).
- wrap when **both parent and child are relational** (non-associative → always parenthesize).
- wrap any `logical_expr` child (lowest precedence).
- `logical_expr`/`not_expr` handling unchanged.

### Validation
- `npm test` (jest + typecheck) stays green — existing golden output unchanged (no nested `binary_expr` in fixtures).
- New golden assertions: `(a+b)*c` → `(?.. + ?..) * ?..`; `a+b*c` (as `binary(+,a,binary(*,b,c))`) stays `?.. + ?.. * ?..`; `a-(b-c)` → `?.. - (?.. - ?..)`; relational-in-relational parenthesized. Prefer an IR/algebra-level unit test in `sparql-serialization`/`expression` tests.

## Phase 2 — G2: DSL-JSON authoring surface (decisions locked)

Context: DSL-JSON is the canonical wire format + the LLM-authoring target (`documentation/dsl-json.md` + `dsl-json-llm-prompt.md`). The doc is currently ideation-only — **nothing persists old-format JSON**, so we can change the format freely, no migration/phases, no wire-version dance. Goal: one short, LLM-friendly grammar with no redundant spellings.

### Locked decisions

**D1 (Q1) — relation-keyed projection is the single canonical form.**
Rewrite `FieldSet.toJSON` (emit) and `FieldSet.fromJSON` (decode) to the short relation-keyed grammar; **delete** the path-keyed `{path, subSelect}` projection spelling and the redundant nested `shape` (inferred from the relation's `valueShape`, already resolved by `walkPathWithCasts`). Projection grammar collapses to three unambiguous cases:
- string → leaf path (`"name"`, `"bestFriend.name"`)
- single-key object → relation: `{ "friends": ["name","hobby"] }` or `{ "friends": { as?, where?, one?, fields } }`; cast via `{ "pets": { "cast":"Dog", "fields":[…] } }`
- `{ "as", "value" }` → computed field
Regenerate the round-trip fixtures and the doc. (See before/after examples in the review thread.)

**D2 (Q2) — word-operator aliases in conditions.**
`equals`→`=`, `notEquals`→`!=`, `gt`→`>`, `gte`→`>=`, `lt`→`<`, `lte`→`<=` recognized by `isOpMap`/decode alongside the symbols. Removes the current silent-wrong decode of `{name:{equals:"x"}}`.

**D3 (Q3) — membership operator `oneOf` / `notOneOf`.**
New feature top-to-bottom (no membership operator exists in the DSL today). Naming **`oneOf` / `notOneOf`** — `notOneOf` is the literal negation of `oneOf` (obvious matched pair, reads "is not one of"), beating `noneOf` (clunky) and `in`/`notIn` (would regress the preferred positive). Avoids `includes`/`excludes`, reserved for a future collection-contains op.
- **Empty list:** `oneOf([])` → constant-false (matches nothing); `notOneOf([])` → constant-true. Do not emit `IN ()`.
- **Single element:** keep as `IN ("x")` (predictable, round-trips), do not collapse to `=`.
- **Wire:** operator-map keys `{ "hobby": { "oneOf": [...] } }` / `{ ..: { "notOneOf": [...] } }`, array-valued, next to the `{ ">": 18 }` tier.
- **Placement:** a boolean predicate — lives in `where` and inside `.some()`/`.every()`; **not** a projection field. (Confirmed: it resolves to a filter.)
- **Element types:** literals **and** named nodes — mirrors SPARQL `IN`, which takes both. Element type follows the property type: literal property → literal list; object property → node-reference list (`{id}`/Shape).
- **Lowering:** IR membership op → SPARQL `?x IN (…)` / `NOT IN (…)`.
- **Deferred (own gap):** value-∈-subquery (`oneOf(Person.select(...))`) and set-to-set (`friends.notIn(...)`) — these are `FILTER (NOT) EXISTS` / anti-join territory, larger than list membership.

**D4 (Q5) — keep doc/fixtures sync simple (for now).**
No generator/CI. Add a `dsl-json` spec-fixtures test that feeds the *documented* JSON examples through `fromJSON` and asserts they decode/lower correctly; manually keep `dsl-json.md` matching those fixtures; add a note in the doc pointing at the fixtures file as the source of truth. (Generator + CI check is a later improvement — backlog.)

### Phases (G2)
- **2a — spec-fixtures harness (D4):** ✅ DONE. `src/tests/dsl-json-spec-fixtures.ts` (source of truth) + `dsl-json-spec.test.ts` driver (`fromJSON → lower → selectToSparql`, asserts documented examples decode); doc note added to `dsl-json.md`. Seeded with 5 currently-working forms. Suite 1457 / typecheck green.
- **2b — word-operator aliases (D2):** decode + fixtures.
- **2c — relation-keyed projection (D1):** `FieldSet.toJSON`/`fromJSON` rewrite, doc rewrite, round-trip + spec fixtures.
- **2d — `oneOf`/`noneOf` (D3):** DSL method + IR op + SPARQL lowering + encode/decode + round-trip + spec fixtures.

Gate each: `npm test` (jest + typecheck); new fixtures lock each; existing tests changed only with sign-off.

## Tasks (2b–2d)  [automatic mode]

Dependency graph: **2b → 2c → 2d**, sequential (2d's decode touches the same `isOpMap`/op-map path 2b edits; 2c is independent but ordered for clean commits). Each phase = one commit, gated by `npm test` (jest + typecheck) and new spec fixtures. Baseline before 2b: **1457 passed / 117 skipped**.

### Phase 2b — word-operator aliases (D2)
Tasks:
1. `DslJsonExpression.ts`: add `OP_ALIASES = {equals:'=', notEquals:'!=', gt:'>', gte:'>=', lt:'<', lte:'<='}`.
2. `isOpMap`: accept a key if it's a symbol **or** an alias (`COMPARISON_OPS.has(k) || k in OP_ALIASES`).
3. Op-map decode (`decodeConditionNode`): normalize `op` through `OP_ALIASES` before building `binary_expr`.
4. Encoder unchanged — symbols stay canonical/emitted; aliases are accepted **input** sugar (matches the doc's "`{equals}` — explicit, same thing").
5. Spec fixtures: add `{name:{equals:'Alice'}}`, `{guardDogLevel:{gt:3}}` (Dog), etc. → assert same SPARQL as the symbol form.
Validation: `npm test` green; new fixtures pass; existing golden/round-trip byte-identical (encoder unchanged). No existing test changed.

### Phase 2c — relation-keyed projection (D1)  ✅ DONE
Result: `FieldSet.toJSON`/`fromJSON` rewritten to the relation-keyed grammar (three shapes: string leaf / `{rel: [...] | {options}}` / `{as,value}`); nested `shape` dropped (inferred from `valueShape`); casts inline in the key. **Round-trip suite stayed green** (IR-equivalence — format-agnostic). Doc projection section + 2 spec fixtures updated. **Deviation (approved format change):** updated format-assertion tests in `serialization.test.ts` (5 assertions) and `field-set.test.ts` (9 constructions) from `{path,subSelect}` to relation-keyed — inherent to D1; no behavior/IR change. Suite 1461 / typecheck green.
Tasks:
1. `FieldSet.fromJSON`: recognize a **relation-keyed** field object — a single non-reserved key (`as`/`value`/`cast`/`where`/`whereIndex`/`customKey` are reserved) whose value is an **array** (sub-fields) or **object** (`{as?, where?, one?, cast?, fields}`). The key is the relation path; nested `shape` is inferred from the segment `valueShape`. Keep bare-string leaves and `{as,value}` computed as-is.
2. `FieldSet.toJSON`: emit the relation-keyed form for relation entries (drop `path`+`subSelect`+nested `shape`); leaves stay bare strings; computed stays `{as,value}`; cast → `{ "<rel>": {cast, fields} }`.
3. Update `FieldSetObjectFieldJSON`/`FieldSetFieldJSON` types + `documentation/dsl-json.md` projection section to the new grammar; update the LLM prompt doc.
4. **Existing tests that assert the OLD emitted JSON structure** (`serialization.test.ts`, `field-set.test.ts` hand-written `{path, subSelect}` inputs) must be updated to the new form — this is the inherent, user-approved consequence of the format change (D1). Round-trip suite is IR-equivalence (format-agnostic) → should stay green.
5. Spec fixtures: add every documented projection form (`{friends:[...]}`, `{friends:{as,where,one,fields}}`, `{pets:{cast,fields}}`).
Validation: `npm test` green; round-trip suite green (IR unchanged); new spec fixtures pass; **flag updated format-assertion tests in the review**.

### Phase 2d — `oneOf` / `notOneOf` (D3)  ✅ DONE (Route A / Rung 1)
Result: first-class `in_expr` IR node (forward-shaped `source: {list}` for a future Rung-2 `{query}` arm), `SparqlInExpr`, `IN`/`NOT IN` emission with empty-list constant folding (`false`/`true`). Wired through all ~9 expression-kind handlers (convert, alias-collect, aggregate-detect, property-collect, required-binding, context-resolve, proxy-resolve, IR-expr-kinds). DSL `oneOf`/`notOneOf` on `ExpressionNode` + `BaseExpressionMethods` + typed on `QueryPrimitive`/`QueryShape` proxies + runtime `EXPRESSION_METHODS`. Decode `{oneOf}`/`{notOneOf}` conditions + `['in']`/`['not-in']` S-exprs; encode symmetric. Tests: `one-of.test.ts` (literal/named-node/empty), 3 round-trip fixtures (auto IR-equivalence), 2 spec fixtures, doc updated. Suite 1471 / typecheck green.
Tasks:
1. IR: add `IRInExpression = {kind:'in_expr', negated:boolean, value:IRExpression, list:IRExpression[]}` to `IntermediateRepresentation.ts`; include in `IRExpression` union.
2. SPARQL algebra: add `SparqlInExpr = {kind:'in_expr', negated, value, list}` to `SparqlAlgebra.ts`; `irToAlgebra.convertExpression` maps `in_expr`→`in_expr`; `algebraToString` emits `${value} IN (${list.join(', ')})` / `NOT IN`. Empty list → constant `false`/`true` (no `IN ()`).
3. DSL: add `oneOf(list)`/`notOneOf(list)` to `ExpressionMethods` (+ `Expr` static if symmetric) returning an `ExpressionNode` of `in_expr`; element type follows the property type (literals vs `{id}` refs).
4. Decode: recognize `oneOf`/`notOneOf` array-valued op-map keys in `decodeConditionNode`/`isOpMap` → `in_expr`; each list element decoded via `decodeValueExpr`.
5. Encode: `encodeCondition` emits `{ "<path>": { "oneOf": [...] } }` / `notOneOf`.
6. Lowering: `lowerWhereToIR` passes `in_expr` through; verify required-binding marking treats `value`'s refs like a comparison.
7. Tests: DSL→SPARQL golden (`IN`/`NOT IN`, empty-list constant), decode/encode round-trip, spec fixtures (literal + id-ref lists), type-probe that element type is checked.
Validation: `npm test` green; new golden + round-trip + spec fixtures pass; typecheck (element-type inference) green.

## Phase 3 — G4 / G6 / G7 mutation-input correctness  ✅ DONE
Result: three fixes + `mutation-input-fixes.test.ts` (5 lock-ins). No existing test changed (none encoded the bugs). Suite 1476 (+5) / typecheck green.

Three small behavior-fixes for silently-wrong / crashing mutation input; each with a lock-in test.

- **G4** — `fieldValueToTerms` (`irToAlgebra.ts`) silently returns `[]` for a computed/expression value in `create`, dropping the field. Create lowers to **INSERT DATA** (ground triples, no WHERE) so expressions can't be evaluated there → **throw a clear error** (use a literal, or update) instead of dropping. Safe for all callers: an expression is never a ground term.
- **G6** — `isSetModificationValue(null)` (`QueryFactory.ts`) throws `TypeError` (`typeof null === 'object'` then `null.$add`). Guard `value === null`. Matches the builder path (null → unset).
- **G7** — `isSetModification` (`MutationQuery.ts`) `return hasAdd || (hasRemove && …)` short-circuits the key-count check, so `{add:[…], name:'x'}` is misclassified and `name` silently dropped. Fix to `(hasAdd || hasRemove) && numKeysExpected === numKeys` (mirrors the correct `isSetModificationValue`).

Validation: `npm test` (jest + typecheck) green; new tests assert G4 throws, G6 no longer crashes (null → unset), G7 no longer drops sibling fields. No existing test changed without sign-off.

## Phase 4 — G9 (per-path sort) + G11 (SetSize comparisons)  ✅ DONE
- **G9:** `SortByPath`/`DesugaredSortBy` now carry per-path `directions[]` (were a single `direction` collapsing hand-authored `[{name:'ASC'},{age:'DESC'}]` to the first). Threaded through `evaluateSortCallback`, `toSortBy`, `IRLower` (per-item), and `serialize`/`deserializeSortByPath`. DSL callback still uniform; the wire now round-trips mixed directions. Updated 2 internal `ir-desugar` assertions (`direction`→`directions`, mechanical).
- **G11 (SetSize comparisons):** `SetSize` gained `gt/gte/lt/lte/neq` (+ long aliases) via a shared `toCountExpr()` → `HAVING(count(…) <op> n)`. `.size().gt(2)` now works (was `.equals()`-only). The `sum/avg/min/max` aggregate DSL remains **backlog 006**.
- Tests: `sort-and-aggregate.test.ts` (4). Suite 1480 (+4) / typecheck green.

## Still open (ideating) — G3+
G4 (expr-in-create), G6/G7 (null / set-mod precedence), G9 (multi-key sort), G11 (aggregates + SetSize comparisons), G12/G13 (Expr drift / SHACL path reader) — not yet scoped.
