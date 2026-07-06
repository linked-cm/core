---
"@_linked/core": patch
---

Fix the package root `types` field, which pointed to a nonexistent `./index.d.ts`. It now points to `./lib/esm/index.d.ts` (the real declarations, matching the `exports` map). Consumers using the legacy `moduleResolution: "node"` (which reads the root `types` fallback rather than the `exports` map) can now resolve `@_linked/core`'s types for the root import; subpath imports already resolved via `typesVersions`.
