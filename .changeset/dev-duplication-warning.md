---
"@_linked/core": patch
---

Dev-only warning when a shape registers under a numerically-suffixed URI (e.g. `.../Person2`) with the same `targetClass` as its base — the signature of a bundler emitting more than one copy of a framework package, which silently breaks cross-runtime shape lookup. Surfaces a build-config regression loudly instead of a no-op at query-forward time.
