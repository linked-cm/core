---
"@_linked/core": minor
---

ESM-only. Dropped the CommonJS build; core now ships ES modules only (`type: module`, no `require` export condition, no `lib/cjs`). CJS consumers on Node 22+ can `require()` it (sync ESM) or use dynamic `import()`. Jest migrated to ESM.
