---
"@_linked/core": patch
---

`validate()` no longer passes silently when it cannot resolve a shape.

Neither inheritance nor nesting is carried inside a `NodeShapeData`: a subclass's `propertyShapes` holds only its own, and a property's `valueShape` is a bare `{id}`. The validator resolves both through the shape registry by id — so a caller holding only decorator-generated shape objects can validate with those alone, and `validate(Slide, data)` and `validate(Slide.shape, data)` return the same report. Passing a shape class remains supported; it was never required.

When such a lookup fails — a shape object whose id was never registered, e.g. one deserialized in a process where the shape definitions were never loaded — the result used to be a false clean bill of health. A shape whose id was unregistered lost its inherited property shapes, so required inherited properties went unchecked *and* any that were supplied were reported as undeclared keys; an unresolvable nested value was skipped entirely, letting a node report `conforms: true` on the strength of a branch that was never looked at.

Both now produce an `sh:NodeConstraintComponent` violation naming the shape that could not be resolved:

```
Cannot validate the value of 'author': its shape '…/Author' is not registered.
Cannot validate the value of 'anything': the property declares no shape for its values.
Add a 'shape' to its @objectProperty decorator, or give the value a 'shape' key.
```

The second case also catches something that previously passed validation and then threw during normalization: a plain object supplied to a property that declares no shape for its values.
