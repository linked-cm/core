---
"@_linked/core": patch
---

Fix SPARQL mutation generation so configured graph scope is applied to create,
update, delete, deleteAll, deleteWhere, and updateWhere mutations.

Fix nested select result hydration so custom container keys and child field keys
are preserved separately. For example,
`image: action.image.select(img => [img.contentUrl])` now hydrates as
`{ image: { id, contentUrl } }` rather than `{ image: { id, image } }`.
