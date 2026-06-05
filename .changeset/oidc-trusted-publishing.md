---
'@_linked/core': patch
---

CI: switch to OIDC trusted publishing.

Publishes from this repo's `publish.yml` workflow now authenticate via GitHub Actions OIDC, signed against the trusted-publisher entry on npm for `@_linked/core`. No `NPM_AUTH_TOKEN` is used. Each published tarball carries provenance attestation.

The npm-side package settings should pair this with `mfa=publish` + Trusted Publisher entry: `linked-cm/core` repo + `publish.yml` workflow. Token-based publishes (including from leaked GH secrets) are then blocked entirely; only this specific workflow can publish.
