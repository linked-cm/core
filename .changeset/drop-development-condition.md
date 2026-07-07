---
"@_linked/core": patch
---

Remove the `development` export condition (pointed at `src`, which isn't shipped to npm). Monorepo dev resolves workspace source via the cli Vite plugin; standalone resolves `import → lib`. No consumer-visible change.
