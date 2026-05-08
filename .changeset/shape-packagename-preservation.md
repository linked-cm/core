---
'@_linked/core': patch
---

`linkedShape`: store un-sanitized `packageName` on each shape constructor during registration. Consumers like `LincdServerProxy.parseShape` can now route backend calls using the real module specifier (e.g. `@_linked/server`) rather than extracting from the URI — the URI form is lossy (`URI.sanitize` strips `@` and `/` to `-`), so round-tripping the sanitized form as a module specifier fails module resolution.
