---
summary: Chapter 3 of report 021 — inconsistencies & functional gaps. Fix the highest-impact items under the established "keep tests green + add lock-in tests" discipline, starting with G1 (arithmetic operator precedence in SPARQL serialization). G2+ explored in ideation before committing.
status: Plan
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

**D3 (Q3) — membership operator `oneOf` / `noneOf`.**
New feature top-to-bottom (no membership operator exists in the DSL today). Naming `oneOf`/`noneOf` (clearest read; avoids the `includes`/`excludes` "collection-contains" ambiguity, which we reserve for a future real collection op).
- **Placement:** a boolean predicate — lives in `where` and inside `.some()`/`.every()`; **not** a projection field. (Confirmed: it resolves to a filter.)
- **Element types:** literals **and** named nodes — mirrors SPARQL `IN`, which takes both. Element type follows the property type: literal property → literal list; object property → node-reference list (`{id}`/Shape).
- **Lowering:** IR membership op → SPARQL `?x IN (…)` / `NOT IN (…)`.
- **Deferred (own gap):** value-∈-subquery (`oneOf(Person.select(...))`) and set-to-set (`friends.notIn(...)`) — these are `FILTER (NOT) EXISTS` / anti-join territory, larger than list membership.

**D4 (Q5) — keep doc/fixtures sync simple (for now).**
No generator/CI. Add a `dsl-json` spec-fixtures test that feeds the *documented* JSON examples through `fromJSON` and asserts they decode/lower correctly; manually keep `dsl-json.md` matching those fixtures; add a note in the doc pointing at the fixtures file as the source of truth. (Generator + CI check is a later improvement — backlog.)

### Phases (G2)
- **2a — spec-fixtures harness (D4):** `src/tests/dsl-json-spec.test.ts` + a fixtures file mirroring the doc's *currently-working* examples; doc note. Small, low-risk, lands first as scaffolding.
- **2b — word-operator aliases (D2):** decode + fixtures.
- **2c — relation-keyed projection (D1):** `FieldSet.toJSON`/`fromJSON` rewrite, doc rewrite, round-trip + spec fixtures.
- **2d — `oneOf`/`noneOf` (D3):** DSL method + IR op + SPARQL lowering + encode/decode + round-trip + spec fixtures.

Gate each: `npm test` (jest + typecheck); new fixtures lock each; existing tests changed only with sign-off.

## Still open (ideating) — G3+
G4 (expr-in-create), G6/G7 (null / set-mod precedence), G9 (multi-key sort), G11 (aggregates + SetSize comparisons), G12/G13 (Expr drift / SHACL path reader) — not yet scoped.
