---
"@_linked/core": minor
---

DSL: a shapeless IRI-valued object property (an `@objectProperty` / SHACL property with no value shape and a non-Literal node kind, e.g. `sh:path`) now projects the value's node reference `{id}` in a `.select()` instead of throwing "No shape set for objectProperty". Mirrors how a `shape: Shape` object property (e.g. `sh:targetClass`) already resolves — lets the DSL read raw IRI predicates back out of a store (e.g. reading a SHACL shape catalog). Polymorphic values (rdf:List / PathNode) resolve to their node ref; full structural projection is the `byShape` follow-up (backlog 031).
