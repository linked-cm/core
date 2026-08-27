---
"@_linked/core": minor
---

Add `canonicalPathKey(expr)` — a stable, prefix-independent identity for a property path.

A `PathExpr` needs a scalar form whenever it is used as an identity: keying a map of properties, comparing two paths, or naming a property across a process boundary. `pathExprToSparql` cannot serve that purpose — it renders for humans and for queries, shortening IRIs via `formatUri`, so the same path serialises differently depending on which prefixes happen to be registered in the current process.

```ts
import {canonicalPathKey} from '@_linked/core/paths/pathExprToSparql';

canonicalPathKey('https://schema.org/name');        // 'https://schema.org/name'
canonicalPathKey({id: 'https://schema.org/name'});  // 'https://schema.org/name' — same key
canonicalPathKey({seq: [a, b]});                    // '<a>/<b>'
canonicalPathKey({inv: a});                         // '^<a>'
```

Absolute IRIs, always, never prefixed, so a catalog written in one process matches the same catalog read in another. A **simple** path returns the bare predicate IRI, so single-predicate property identities are unchanged and only complex paths gain a new spelling. Note it is an *identity*, not a round-trippable path: a bare IRI is not valid property-path syntax, so a simple key cannot be fed back to `parsePropertyPath` (complex keys can).

**Fixes:** `normalizePropertyPath` threw on any bare absolute IRI. `'https://schema.org/name'` contains `/`, so it matched the path-operator test and was handed to the path parser, which then failed on the `//` in the scheme. This was invisible for as long as paths arrived as `NamedNode`s or prefixed names from decorators, and appears the moment a plain IRI string is used — which is every simple property in a shape catalog. A hierarchical IRI is now distinguished from a prefixed-name sequence, so `'ex:a/ex:b'` still parses as a sequence and `'<a>/<b>'` still parses as an expression.

`PropertyShapeConfig.path` now documents all four accepted forms, including that an ontology term is passed **directly** (`documents.confidence`) and never via `.id` — which would unwrap it back to the bare string.
