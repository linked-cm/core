---
"@_linked/core": minor
---

Repo-wide analysis follow-through (reports 022–025): leanness, security hardening, and functional-gap fixes. Highlights users should know about:

**New query capabilities**
- Membership: `.oneOf([...])` / `.notOneOf([...])` on any query property → SPARQL `IN` / `NOT IN` (empty list constant-folds to match-nothing / match-everything). Works in `.where()` and inside `.some()`/`.every()`.
- Set size comparisons: `.size().gt(n)` (and `gte`/`lt`/`lte`/`neq`) → `HAVING(count(…) <op> n)`, not just `.equals()`.
- Multi-key sort now honors a per-path direction: `sortBy: [{name:'ASC'}, {age:'DESC'}]` no longer collapses to the first direction.

**New exports**
- `Shape` and `LinkedStorage` are now exported from the package root; the SPARQL layer is reachable at `@_linked/core/sparql`.

**SHACL**
- `minInclusive`/`maxInclusive`/`minExclusive`/`maxExclusive`/`minLength`/`maxLength`/`pattern` on a property now serialize into the synced shape (previously declared but silently dropped).

**Correctness fixes (previously silent-wrong or crashing)**
- SPARQL operator precedence: nested arithmetic like `a.plus(b).times(c)` now parenthesizes correctly (was emitted as `?a + ?b * ?c`).
- Mutation input: a computed value in `create` now throws a clear error instead of silently dropping the field; a `null` mutation value no longer crashes; `{add:[…], name:'x'}` no longer silently discards `name`.
- Nested-select pagination (`.friends.select(...).limit(5)`) now survives DSL-JSON round-trips instead of returning the unbounded set.

**DSL-JSON wire format** (canonical/interop format — see `documentation/dsl-json.md`)
- Reconciled with its spec and made more LLM-authorable: relation-keyed projection is the single canonical form; word-operator aliases (`equals`/`gt`/…) are accepted alongside symbols; the seven system value-tags are now `@`-sigiled (`@id`, `@ctx`, `@date`, `@list`, `@add`/`@remove`, `@unset`, `@path`) so a property may be named `date`/`id`/`path`/… without collision. No released consumer persists the old format.

**Action needed / behavior changes**
- **`Expr` module trimmed** — the property-first delegators (`Expr.plus`, `Expr.eq`, `Expr.regex`, `Expr.bound`, `Expr.ucase`, …) were removed. Use the fluent form instead: `p.age.plus(1)`, `p.name.matches(/^A/)`, `p.name.isDefined()`, `p.hobby.oneOf([…])`. `Expr` keeps only the non-property-first ops: `now`, `ifThen`, `firstDefined`, `concat`, `not`.
- **Louder errors** — accessing an undecorated property inside a query callback now throws (it previously warned and returned a garbage constant); `setQueryContext` with an unmaterializable value throws instead of silently no-op'ing; `create`/`update` now reject cardinality (`minCount`/`maxCount`) and literal-vs-relation kind violations at build time.

**Security** — closed both critical SPARQL-injection vectors (unvalidated IRIs in `formatUri`, unescaped function/aggregate names), plus variable sanitization, a decode recursion-depth cap (DoS), and prototype hygiene on inbound JSON.

**Leanness** — removed ~1000 lines of dead code, dropped an unused runtime dependency, stopped publishing test-helpers in the package artifact, and fixed a `NodeShape.type` predicate that was clobbered to `sh:description`.
