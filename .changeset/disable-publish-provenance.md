---
'@_linked/core': patch
---

CI: remove `publishConfig.provenance: true`. npm registry rejects publishes with provenance when trusted-publishing isn't configured for the package. Aligns with the other `@_linked/*` packages, which publish without provenance.
