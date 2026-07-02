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

## G2+ — ideation (not yet implemented)
Explore DSL-JSON spec-vs-code drift (G2) with the user before planning: catalogue documented-but-unimplemented forms, decide implement-vs-document-down per item.
