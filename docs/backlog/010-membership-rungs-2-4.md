---
summary: Deferred higher rungs of the membership feature. Rung 1 (value ∈ explicit list → SPARQL IN/NOT IN, `oneOf`/`notOneOf`) shipped in report 024 / plan 003. Rungs 2–4 extend membership to subqueries and collection/set semantics, lowering to EXISTS / anti-join rather than IN.
packages: [core]
---

# 010 — Membership: Rungs 2–4

> Source: deferred from plan 003 / report 024 (G2, D3). Rung 1 is done; the IR
> node `IRInExpression` is **forward-shaped** (`source: {list}`) so the Rung-2
> `{query}` arm is additive — no change to the `oneOf`/`notOneOf` DSL surface or
> the node's identity.

## Rung 2 — value ∈ subquery result (correlated membership)
```ts
p.status.oneOf(Config.select(c => c.allowedStatus))   // "status is among the allowed ones"
p.bestFriend.oneOf(Person.where(x => x.isAdmin))       // "bestFriend is one of the admins"
```
SPARQL 1.1 has no `IN (SELECT …)`, so this lowers to a **correlated semijoin**:
```sparql
FILTER EXISTS { ?c a :Config ; :allowedStatus ?status }   # correlated on ?status
```
Work: add the `{query}` arm to `IRInExpression.source`; DSL `oneOf`/`notOneOf`
overloads accept a query; lowering dispatches list→`IN`, query→`EXISTS`; encode a
nested query inside a condition; round-trip + spec fixtures. Medium-large.

## Rung 3 — collection vs collection (set relations)
```ts
p.friends.oneOf(Person.where(...))     // ∃ overlap  → EXISTS with a join
p.friends.notOneOf(bannedPeople)       // anti-join   → NOT EXISTS
```
Existential/universal quantification of a *plural* relation against a set;
overlaps `.some()`/`.every()`. Larger; decide whether it's `oneOf` overloads or
distinct methods (e.g. `.intersects()` / `.disjointFrom()`).

## Rung 4 — set algebra
`intersects`, `subsetOf`, `disjoint`, `containsAll` between two collections — a
full relational-set layer, adjacent to the shared-variable-bindings/joins idea in
`docs/ideas`. Its own epic.

## Naming note
Rung 2 may reuse `oneOf`/`notOneOf` (overloaded on list-or-query). For Rungs 3–4,
prefer explicit names that signal the `EXISTS`/join semantics rather than
overloading membership, so the reader knows a subquery/collection is involved.
