---
"@_linked/core": minor
---

Shapes are now metadata-only: `Shape` subclasses can no longer be instantiated, and SHACL metadata is exposed as plain objects.

**Behavioral change — `new SomeShape()` throws.** Constructing any `Shape` subclass now throws a clear error steering you to the DSL (`Shape.select(...)`, `.create(...)`, `.update(...)`, `.delete(...)`). Shapes never carried live data — their decorated getters only returned typing stubs — so this turns a silent footgun into a loud error. All querying and mutation continues to go through the DSL exactly as before.

**Metadata is plain objects.** `SomeShape.shape` and each property shape are now plain `NodeShapeData` / `PropertyShapeData` objects (importable as types from `@_linked/core`), not class instances. The former `NodeShape` / `PropertyShape` instance methods are now free functions, exported from the package:

```ts
import {
  getPropertyShapes,        // (nodeShape, includeSuperClasses?) => PropertyShapeData[]
  getUniquePropertyShapes,  // (nodeShape) => PropertyShapeData[]
  getPropertyShape,         // (nodeShape, label, checkSubShapes?) => PropertyShapeData | undefined
  addPropertyShape,         // (nodeShape, propertyShape) => void
  nodeShapeEquals,          // (a, b) => boolean
} from '@_linked/core';

// before: Person.shape.getUniquePropertyShapes()
// now:    getUniquePropertyShapes(Person.shape)
```

If you read shape metadata via the old instance methods, switch to these free functions; if you only use the query DSL, no change is needed.

**Deprecations (scheduled for removal):** `Shape.getSetOf`, `Shape.mapPropertyShapes`, `propertyShapeToResult`, and the `PropertyShapeResult` type. Read the plain `PropertyShapeData` fields directly instead of the result projection.

**`SparqlDataset` no longer extends `Shape`.** A SPARQL-backed dataset is a live store, not a metadata shape; it never used any `Shape` member. This has no effect on constructing or using datasets/stores.
