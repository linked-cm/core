---
"@_linked/core": minor
---

Development-mode source resolution and an instance-count diagnostic.

- **Conditional `development` exports.** `package.json` now declares a `development` export condition resolving to `./src/*.ts` (and `./src/index.ts` for the root). Vite's browser-side resolver picks the TypeScript source in dev mode, enabling HMR-on-source for `@_linked/core` from a consuming app. Production resolution (`import` → `lib/esm`, `require` → `lib/cjs`, `types`) is unchanged.
- **`LinkedStorage.getLoadedInstanceCount(): number`** — new public static method reporting how many `@_linked/core` instances are registered on the global tree (a diagnostic for the Vite-SSR-vs-Node-resolver dual-load split).
