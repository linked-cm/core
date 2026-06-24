---
"@_linked/core": minor
---

SPARQL generation: structured property paths on named properties, and inner pagination for nested selects.

**Structured `sh:path` on named properties now resolve correctly.** A query that references a named property whose SHACL `sh:path` is structured (a sequence `[a, b]`, an inverse `^p`, or an alternative `a|b`) previously collapsed to a shadow IRI and matched nothing. It now emits the correct SPARQL property-path predicate. Simple single-predicate properties are unaffected (output unchanged).

**Nested selects can now bound a related collection with `.limit()` / `.offset()` / `.orderBy()`** — when the outer query targets a single subject:

```ts
// Up to 2 friends, ordered, for one person
Person.select((p) => p.friends.select((f) => f.name).orderBy((f) => f.name).limit(2)).for({id});
```

This emits a real SPARQL sub-`SELECT … ORDER BY … LIMIT … OFFSET …` that bounds the collection per parent. `orderBy` accepts a proxy callback (`f => f.name`) or a property-name string and defaults to ascending.

Notes:
- Per-group pagination across **multiple** parents is not supported and now throws a clear error instead of silently applying a global limit. The same applies to `.limit()` on a deeper (grandchild) collection, and to `.limit()` called directly on a traversal without `.select(...)`.
- Queries with no inner pagination are emitted exactly as before.
