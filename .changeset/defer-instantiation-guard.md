---
"@_linked/core": patch
---

Temporarily relax the `new Shape()` constructor guard.

The guard added in the shape-instantiation work rejects `new SomeShape()` outright, on the principle that shapes are metadata rather than data. That principle stands — but several framework classes legitimately `extends Shape` and are constructed as runtime service objects (`LinkedServer`, `BackendAPIStore`, `LocalFileStore`, `LincdAPI`, `LincdWebApp`), and the guard crashes a consuming backend at boot.

The constructor returns to its pre-guard behaviour: it accepts an optional node reference and sets `id`, mirroring `createShapeTarget`. `validate()` / `assertValid()` from the same release are **untouched** — only the constructor throw is deferred.

This is a deliberate, temporary relaxation, kept as one revertible commit. Re-enable the guard once those classes move to composition or a non-`Shape` base.
