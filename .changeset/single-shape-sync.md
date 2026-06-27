---
'@_linked/core': minor
---

Add `syncShape(target)` — a scoped, single-shape counterpart to `syncShapes()`.

Materializes **one** code-registered NodeShape into the store (delete → recreate, so the delete
cascade-cleans the old property-shape / list / path subtrees and the create rebuilds them) and does
**not** run the store-wide orphan sweep, so other shapes in the store are untouched. Useful when an
app/package wants to bind a single reused shape into a dataset without reconciling (or pruning) the
whole shape set.

```ts
import { syncShape } from '@_linked/core';

await syncShape(Person)();                 // by shape class
await syncShape(Person.shape.id)();        // or by NodeShape IRI
// composes with itself / syncShapes (each returns one unexecuted thunk):
await Promise.all([syncShape(Person), syncShape(Address)].map((run) => run()));
```

Accepts a shape class or its NodeShape IRI string; throws for framework/meta shapes and
unregistered IRIs. The per-shape sync thunk is now rebuilt fresh on each invocation, so a thunk
can be safely re-run (idempotent). See `docs/reports/016-shacl-rdf-serialization.md`.
