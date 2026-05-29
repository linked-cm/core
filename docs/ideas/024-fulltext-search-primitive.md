---
summary: Add an index-backed text-search primitive `.search(text, options?)` to the query DSL — universal entry point that picks the fastest available path per IDataset backend (Lucene FTS on Fuseki, FILTER fallback on bare SPARQL, future SQL FTS on relational backends).
packages: [core, fuseki]
---

# Fulltext / `.search()` DSL primitive — Ideation

## Context

The Linked Query DSL today exposes per-property predicates for text matching, all of which compile to SPARQL `FILTER` expressions (O(n) literal scans):

| Method | SPARQL | Use |
|---|---|---|
| `.equals(value)` | `?x = value` | exact equality |
| `.matches(pattern, flags?)` | `REGEX(?x, pattern, flags)` | regex (structural patterns, validation) |
| `.contains(substr)` | `CONTAINS(?x, substr)` | case-sensitive substring scan |
| `.startsWith(prefix)` | `STRSTARTS(?x, prefix)` | case-sensitive prefix scan |
| `.endsWith(suffix)` | `STRENDS(?x, suffix)` | case-sensitive suffix scan |

**Gap**: there is no index-backed FTS primitive. On a Fuseki dataset with the `text:` Apache Jena Lucene extension enabled, queries like `text:query "alice*"` execute in milliseconds against an inverted index. The DSL has no way to express this — callers either use the slow `.contains() / .startsWith()` fallbacks or drop down to raw SPARQL strings.

### Concrete trigger (CN context)

Create Now's `InstanceProvider.searchInstances` (in `packages/create-now-js/src/shapes/InstanceProvider.ts`, originally authored by Carlen Young in February 2026 as `ProjectProvider.searchInstances`, then extracted in iter-4) uses raw SPARQL:

```sparql
PREFIX text: <http://jena.apache.org/text#>
SELECT DISTINCT ?subject ?label ?image WHERE {
  (?subject ?score) text:query "${safeText}*" .
  GRAPH <${defaultGraph}> {
    ?subject a <${targetClassUri}> .
    ...
  }
}
```

This powers `CustomMultiSelect` (the multi-select picker for object-property form fields in CN's CMS-mode UI). After CN promoted "raw SPARQL is a smell" to a Phase-1 architectural rule (arch-10), `searchInstances` is one of the sites that must convert — but it can't until the DSL has an index-backed FTS primitive.

### What exists today in `@_linked/core`

**DSL expression methods** — `SelectQuery.ts:856–857`:
```
'concat', 'contains', 'startsWith', 'endsWith', 'substr', 'before', 'after',
'replace', 'ucase', 'lcase', 'strlen', 'encodeForUri', 'matches',
```
All compile to SPARQL FILTER expressions via `ExpressionNode` (e.g. `REGEX` for `.matches()` at `ExpressionNode.ts:263`).

**SPARQL emission** — `SparqlDataset` compiles `IRExpression` → SPARQL string. No special-casing for Lucene `text:query`.

**Backend abstraction** — `IDataset` has `selectQuery / updateQuery / createQuery / deleteQuery`. No capability declaration mechanism (a dataset can't currently say "I support fulltext").

## Use cases

| # | Scenario | Concrete example |
|---|---|---|
| **UC1** | Prefix autocomplete ("typeahead") | User types `al` in a person picker → match `Alice`, `Alex`, `Alan`. |
| **UC2** | Token-aware multi-word search | User types `john smith` → match `"John Smith"`, `"Smith, John"`, `"Dr. Smith John Q."` (both tokens present, order-independent). |
| **UC3** | Fuzzy / typo-tolerant (**future, not v1**) | User types `jhon` meaning `john` → still finds `John`. |

Phrase ("contains exact word sequence in order") is **NOT** a separate mode — it's equivalent to `mode: 'contains', caseSensitive: false` for non-tokenized backends and only meaningfully different from contains+ci when the engine also tokenizes (rare in DSL-typical use cases like Person/Topic search).

## How existing systems handle these

| | UC1 prefix | UC2 token-aware | UC3 fuzzy |
|---|---|---|---|
| **ElasticSearch** | `prefix` query | `match` query | `match` with `"fuzziness":"AUTO"` |
| **PostgreSQL FTS** | `to_tsquery('al:*')` | `to_tsquery('john & smith')` | `pg_trgm` ext (separate) |
| **Apache Jena Lucene** | `text:query "al*"` | `text:query "john smith"` | `text:query "jhon~"` |
| **MongoDB $text** | not native (use $regex) | `$search: 'john smith'` | not native |
| **Algolia** | auto (prefix-by-default) | `search('john smith')` | auto typo tolerance |
| **Meilisearch** | auto | `search('john smith')` | auto typo |
| **Prisma** | not exposed | `{ search: 'john & smith' }` | not exposed |

Two naming camps: search-engine-shaped libs (Algolia/Meilisearch/Prisma) use a single `.search()`; query-language libs (ES/PG) use distinct methods per mode. We pick the search-shaped pattern (single `.search()` + options) for terseness and natural feel.

## Goals

1. **Single canonical text-search entry point** — `.search(text, options?)` — with per-call mode + case-sensitivity options.
2. **Backend-portable** — DSL surface unchanged across `SparqlDataset` (Fuseki, with or without Lucene), future `SqlDataset` (with PG FTS / MySQL FULLTEXT), future API-backed datasets.
3. **Graceful degradation** — when a backend doesn't support an index-backed mode, the call still works (falls back to the equivalent FILTER pattern that `.contains() / .startsWith()` would produce today). Never silently changes semantics.
4. **Unify the existing slow predicates** — `.contains() / .startsWith() / .endsWith()` become 1-arg sugar over `.search()` preserving today's case-sensitive default behavior, but now route through the same backend dispatch and get the fast path for free when available.
5. **Compose with the rest of the DSL** — `.search()` returns an `ExpressionNode` like any other predicate; works inside `.where(p => p.name.search('al').or(p.email.search('alice')))`.

## Decisions (locked-in during iter-7 ideation)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | API name | `.search(text, options?)` | Natural ("`p.name.search('al')`"), single method matches Algolia/Prisma convention, doesn't collide with existing `.matches()` (regex) or `.contains()` (substring scan). Considered `.fulltext()` (more explicit but more technical) — rejected for being heavier than needed once we collapsed the slow predicates into the same router. |
| D2 | Semantics | **Both** property-scoped (`p.name.search('alice')`) and shape-wide (`p.search('alice')` — expands internally to OR over all literal properties of the shape). | Property-scoped is the explicit case; shape-wide is what `CustomMultiSelect`-style pickers actually want (search across name/email/title/etc. without enumerating). Implementation reads the shape's literal-property metadata to expand the OR. |
| D3 | Operator surface (v1) | `mode: 'prefix' \| 'contains' \| 'suffix' \| 'tokens'` + `caseSensitive: boolean` option. Default `{ mode: 'tokens', caseSensitive: false }` — matches a user typing in a search box. No fuzzy/phrase in v1. | `'tokens'` covers the user's intuition (typing `"john smith"` finds anyone with both names); other modes target specific UX (typeahead = prefix, substring search = contains). Auto-escape Lucene/SPARQL special characters so callers can pass arbitrary user input without breaking the query. |
| D-Legacy | Legacy predicates | `.startsWith(s) / .contains(s) / .endsWith(s)` stay as **1-arg sugar** over `.search()`. They route through the same backend dispatch (gaining fast-path access on FTS-capable backends) but preserve today's case-sensitive default behavior. For case-insensitive, callers use `.search(s, { mode: 'prefix' / 'contains' / 'suffix' })` directly. | Migration is transparent — existing call sites compile and behave the same. Users can't accidentally pick the slow path when a fast one exists. One-arg keeps the sugar lightweight; full options surface is on `.search()`. |
| D-Regex | `.matches(regex, flags?)` | **Stays separate.** Not subsumed under `.search()`. Different operator (structural pattern match, returns boolean, no relevance ranking). No rename to `.match` (singular) — migration cost outweighs naming-purity gain; `.matches()` is also semantically accurate (Java `Matcher.matches()`). | Regex has real non-search use cases: structural URI matching, format validation, data-quality scans, migration queries. Conceptually distinct from "search for things matching this text". |
| D-Phrase | Phrase mode | **Not a separate mode.** Equivalent to `mode: 'contains', caseSensitive: false` for non-tokenized backends. | Phrase only meaningfully differs from contains+ci when the engine tokenizes AND you want adjacency+order constraints. For DSL-typical use (Person/Topic search, short literals), phrase IS contains. Don't add false complexity. |

### Compile dispatch table per IDataset

How each backend handles each `{ mode, caseSensitive }` combination:

| mode | caseSensitive | Lucene-backed Fuseki | Bare SPARQL (Fuseki without text:) | Future SqlDataset |
|---|---|---|---|---|
| `prefix` | true | `STRSTARTS(?x, "al")` (Lucene index is case-folded; can't help with case-sensitive) | `STRSTARTS(?x, "al")` | `?x LIKE 'al%'` |
| `prefix` | false | `text:query "al*"` (fast indexed) | `STRSTARTS(LCASE(?x), "al")` | PG: `?x ILIKE 'al%'` or FTS prefix |
| `contains` | true | `CONTAINS(?x, "al")` (Lucene wildcards slow + case-folded — not worth it for case-sens) | `CONTAINS(?x, "al")` | `?x LIKE '%al%'` |
| `contains` | false | `text:query "*al*"` (Lucene wildcard, slowish) OR `CONTAINS(LCASE(?x), "al")` — backend's choice | `CONTAINS(LCASE(?x), "al")` | PG: `?x ILIKE '%al%'` |
| `suffix` | true / false | `STRENDS(?x, "al")` (Lucene has no suffix index — always slow) | `STRENDS(?x, "al")` (LCASE wrap if !cs) | `?x LIKE '%al'` |
| `tokens` | (always insensitive) | `text:query "${text}"` (default tokenize) | tokens.split → AND of `CONTAINS(LCASE(?x), tok_i)` (slow but correct) | PG: `to_tsquery('${tokens.join(' & ')}')` |
| `fuzzy` (future) | (always insensitive) | `text:query "${text}~"` | throw `[IDataset] fuzzy not supported on this backend` OR fall back to closest-edit-distance substring | PG: `pg_trgm` similarity |

## Out of scope

- **Phrase as a first-class mode** — see D-Phrase. Use `mode: 'contains', caseSensitive: false`.
- **`.matches()` → `.match()` rename** — see D-Regex. Keep as-is.
- **Subsuming regex into `.search()`** — see D-Regex. Different operator, different mental model.
- **Multi-property explicit list** — e.g. `p.search('alice', { properties: ['name', 'email'] })`. Current scope is: explicit single property OR all-literal-properties via shape-wide. If a future use case wants "these 3 specific properties," add `properties` option then; YAGNI for v1.
- **Relevance scoring** — `text:query` returns a `?score`; we ignore it for v1 (return order is whatever the backend produces). If scoring is needed, that's a follow-up.

## Open decisions (next ideation batch)

- [ ] **D4 — Backend dispatch / fallback strategy.** How does each `IDataset` declare FTS support? Capability flag (`ds.capabilities.has('fts:tokens')`)? Method on `IDataset` (`ds.supports(mode)`)? Try-and-fall-back at runtime? What happens when a backend doesn't support the requested mode — throw, warn, silently fall back to FILTER?
- [ ] **D5 — Where the primitive lives in `@_linked/core`.** New method on the query builder (`SelectQuery.ts` EXPRESSION_METHODS)? New IR node (`IRSearchExpression`)? Or compose from existing IR primitives (combine FILTER + an opaque `fts_hint` IR node that backends recognize)? How does the shape-wide form get the literal-property list at IR-build time?
- [ ] **D6 — Test fixtures.** Real Fuseki+Lucene (CI service container)? Mock `IDataset` implementations? Use existing `packages/core/src/tests/sparql-fuseki.test.ts` infrastructure? What `cn-main-test`-style isolation pattern?

## Implementation hints

### DSL surface

Add `'search'` to the `EXPRESSION_METHODS` set in `packages/core/src/queries/SelectQuery.ts` (around line 852). The proxy machinery already converts `p.name.search('al', opts)` into an `ExpressionNode` invocation; we then need a corresponding `search(text, opts)` method on `ExpressionNode` that builds the IR.

For the shape-wide form (`p.search('al')`), the proxy receiver is the shape root rather than a property — needs a separate dispatch path. Look at how `.equals()` works when called on the root vs on a property (lines 909–925).

### IR

Two viable options for D5:

1. **New IR kind** — `IRSearchExpression = { kind: 'search_expr', subject: IRExpression, text: string, mode: ..., caseSensitive: ..., shapeWide?: boolean, properties?: string[] }`. Cleanest to inspect downstream; each `IDataset` pattern-matches on `'search_expr'` and emits its own SPARQL/SQL.

2. **Function-expr with sentinel name** — `IRFunctionExpression` with `name: '__linked_search__'` and args carrying the options. Reuses the existing IR primitive; backends still pattern-match the name.

Option 1 is cleaner for static analysis; option 2 is fewer surface changes. Decide in D5.

### SPARQL emission (FusekiStore)

Generic `SparqlDataset` emits the FILTER fallback (the "Bare SPARQL" column in the dispatch table). `FusekiStore` overrides to use `text:query` for tokens / prefix-case-insens / fuzzy paths. The Lucene query string composition needs careful escaping of Lucene-reserved characters (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`) before appending the `*` for prefix mode.

Reference: Apache Jena `jena-text` config + query syntax — https://jena.apache.org/documentation/query/text-query.html

### Sugar-method routing

`.startsWith(s)` etc. live on the property proxy. After this change they should:
- Build the same IR node `.search()` builds, with `{ mode: 'prefix' / 'contains' / 'suffix', caseSensitive: true }` hardcoded.
- Visible to backends as "this is a search-IR, here are the options" — backends route uniformly. Generic SparqlDataset emits today's `STRSTARTS` / `CONTAINS` / `STRENDS` (no behavior change). FusekiStore COULD route to text:query for `mode: 'prefix' + caseSensitive: false` — but for the legacy sugar (always cs:true) it's identical to the existing emission. No behavior change for existing callers.

## Tests

(To be expanded in D6.)

Starter list:

1. **Existing operator-equivalence tests** — `.startsWith('Al')` produces the same query plan as `.search('Al', { mode: 'prefix', caseSensitive: true })`. Same for `.contains` / `.endsWith`.
2. **Mode dispatch on a stub IDataset** — verify that a fake backend with `capabilities = ['fts:tokens']` gets a `search_expr` IR node; backend without that capability gets the FILTER fallback IR.
3. **Lucene compilation** — `text:query "al*"` SPARQL emitted by FusekiStore for `mode: 'prefix', caseSensitive: false`. Tokens mode emits `text:query "john smith"` (no special escaping).
4. **Lucene character escaping** — `.search('a+b', { mode: 'prefix' })` against FusekiStore emits Lucene query with `+` escaped as `\+`.
5. **Shape-wide expansion** — `Person.where(p => p.search('alice'))` expands to OR over Person's literal properties at IR-build time.
6. **Case-sensitivity round-trip** — `.search('AL', { mode: 'prefix', caseSensitive: false })` matches a literal `"alice"`.
7. **Integration test against real Fuseki+Lucene service** — `packages/core/src/tests/sparql-fuseki.test.ts` already has the test-Fuseki container infrastructure; add fixtures with a Lucene-configured dataset.

## Status / sequencing

**Currently deferred from CN Phase 1** — the trigger (CN's `InstanceProvider.searchInstances`) is Carlen Young's February 2026 code, predating CN's Phase 1.7 raw-SPARQL cleanup recency cutoff (~2026-03-22). It will be converted when CN's Phase 2 or 3 reviews the CMS feature surface that depends on `searchInstances`.

This `@_linked/core` ideation can land independently — the primitive is useful beyond CN's specific trigger (any Linked Query consumer with Lucene-enabled Fuseki can use it immediately).

**Suggested implementation order:**

1. Lock the remaining D4-D6 decisions.
2. Implement the IR kind + DSL surface.
3. Implement bare-SparqlDataset FILTER emission (no behavior change for existing sugar-method callers).
4. Implement FusekiStore Lucene emission for the modes that benefit.
5. Convert the sugar methods (`.startsWith / .contains / .endsWith`) to route through the new search-IR.
6. Add tests per D6.
7. Document in `@_linked/core` README.

**Related ideation:**
- `017-upsert.md` — orthogonal but referenced from CN's Phase 1.7 ideation (we hit a similar upsert gap with `UserProjectContextProvider.setActiveBranch`).
- `012-aggregate-group-filtering.md` and `016-aggregations.md` — related but distinct (this idea is about WHERE-clause text predicates; those are about SELECT aggregations).
- `020-distinct.md` — also a WHERE/SELECT modifier; not directly related but similar surface-area question.

## Notes / open hands

- DSL aesthetics matter more than my analysis says. If `.search()` ever feels wrong in real CN code, revisit.
- The shape-wide form (`p.search('al')`) is where most of the implementation complexity lives — it has to enumerate the shape's literal properties at IR-build time. Property-scoped (`p.name.search('al')`) is straightforward.
- Future modes (fuzzy, phrase-with-tokens, boost/ranking) all extend `options` rather than the method surface — that's the whole point of D3's options-bag choice.
