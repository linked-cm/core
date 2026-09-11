---
'@_linked/core': patch
---

Fix `Class extends value undefined` when registering a runtime shape — `getOrCreateShapeAdapter`
captured `Shape` at module-evaluation time, which could be before `Shape.js` had finished.
