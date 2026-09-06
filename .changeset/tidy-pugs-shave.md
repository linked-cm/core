---
'@_linked/core': patch
---

Register `PropertyShape.defaultValue` as a queryable property.

`sh:defaultValue` was read from config and emitted by `PropertyShape.getResult()`,
and the published `ShapeDetails` type declares it — but the property was never
registered in the meta-model, so any query referencing `defaultValue` threw
before executing. Adds the missing `sh:defaultValue` ontology term and its
`createPropertyShape` registration, mirroring the existing generic `hasValue`
registration (literal or IRI, `maxCount: 1`).
