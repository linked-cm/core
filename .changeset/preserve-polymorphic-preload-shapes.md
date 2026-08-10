---
"@_linked/core": patch
---

Preserve concrete nested shapes when serializing polymorphic `preloadFor()` queries. A preload such as `person.pets.as(Dog).preloadFor(DogCard)` now records the `Dog` shape IRI on the wire, allowing fields defined only on `Dog` to resolve correctly after client-server deserialization.
