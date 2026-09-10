---
'@_linked/core': patch
---

Fix `update(expr).where(…)` writing one value per node in the store when the expression traverses a
relation.

```ts
Person.update((p) => ({hobby: p.bestFriend.name.ucase()}))
      .where((p) => p.name.equals('Moa'));
```

The traversal's leaf property was emitted as an `OPTIONAL` *beside* the traversal edge rather than
inside it, and before it:

```sparql
OPTIONAL { ?__trav_0__ <…/name> ?__trav_0___name . }   # subject var not yet bound
OPTIONAL { ?a0 <…/bestFriend> ?__trav_0__ . }
```

The first `OPTIONAL` introduces `?__trav_0__` and so shares no variable with anything to its left —
a left join with no join condition, i.e. a cartesian product over every node in the store carrying
that predicate. The second cannot repair it: the variable is already bound, and `OPTIONAL` never
removes rows. Every resulting row then reached the `INSERT`, so a single-valued property was written
once per named node, with values taken from unrelated nodes.

The leaf is now nested inside the edge's `OPTIONAL`, which is what `.for(id)` already emitted for the
identical expression — the two mutation paths disagreed.

Only `update()` with a **computed expression that traverses a relation** *and* a `.where()` clause is
affected. Plain `update().where()`, and any `update().for(id)`, were already correct.
