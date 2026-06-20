---
'@_linked/core': patch
---

`initTree()` is now idempotent: if `global.lincd` already exists (which
happens structurally under Vite SSR — Vite resolves `@_linked/core/utils/Package`
from `src/`, and any `/* @vite-ignore */` dynamic import via Node's resolver
gets it from `lib/esm/`), the function attaches to the existing registry
instead of throwing or warning.

Previous behavior used a `_lincdMultiWarned` one-shot flag that logged a
warning on the second initialization. This was framed as "interim" but
was actually the correct semantic for the Vite-SSR-vs-Node-resolver split.
The new code expresses the same behavior as the explicit design rather
than as a workaround.

No API change. Existing consumers see the same `lincd` global tree they
saw before. Apps that previously saw "Multiple versions of Linked are
loaded — accepted during HMR/Vite interim" in their dev log will no
longer see that line.

Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).
