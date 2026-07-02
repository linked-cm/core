---
"@_linked/core": patch
---

Fixed 9 correctness bugs in query lowering and result mapping, found by a new end-to-end coverage suite that runs queries through the live-query/store contract against a real SPARQL endpoint. Most of these produced silently wrong results (empty arrays, dropped rows, or values misattributed to the wrong entity) rather than errors, so existing code that hit them was returning incorrect data without any indication of failure.

**`.where()` filters that should tolerate an unbound property now do:**
- `p.someProp.isNotDefined()` previously always returned `[]` — the property was inner-joined, so rows lacking it were dropped before the "is it missing" check ran. It now correctly returns the entities lacking the property.
- `p.someProp.defaultTo(fallback).equals(fallback)` previously also returned `[]` for the same reason — the fallback was unreachable. It now matches entities missing the property.
- `Expr.ifThen(cond, thenVal, elseVal)` used in a `.where()` previously inner-joined properties referenced by *both* branches, dropping entities the taken branch would have matched even when the untaken branch referenced a property they don't have. Only the condition's properties are required now.

**`Expr.ifThen`, `Expr.firstDefined`, and `Expr.concat` now resolve proxy-traced properties correctly.** Previously, a property access inside one of these (e.g. `Expr.ifThen(p.name.equals('x'), ...)`) could evaluate against an arbitrary, unrelated row instead of the query subject — these functions now carry the same property-resolution context as their instance-method equivalents.

**Sub-selects with an inline filter now keep that filter.** `p.friends.where(f => f.name.equals('x')).select(f => [...])` previously dropped the `.where()` silently and returned all friends, including nesting a filter inside another filtered sub-select.

**A nested aggregate now scopes to the right entity.** `p.friends.select(f => ({count: f.friends.size()}))` previously attached `count` to the *parent* row instead of each friend.

**`.one()` no longer truncates an entity's own nested/multi-valued data.** A single-entity query with a traversal or plural property (e.g. `p.friends.select(...).where(...).one()`) previously used a row-level `LIMIT 1` that could cut off part of the one entity's own data instead of just selecting that entity.

**A computed expression over a traversed path (e.g. `p.bestFriend.name.ucase()`) in a projection no longer produces invalid SPARQL**, and the same expression used inside an `.update()` mutation no longer silently corrupts unrelated entities when the traversal target is absent.

No public API changes. See `docs/reports/020-linked-query-test-coverage.md` for the full root-cause writeups.
