---
"@_linked/core": minor
---

## Artifact publishing capability

Adds `IArtifactStore` — a restricted object-storage interface for immutable app releases (used by `@_linked/cli` `publish-app` / web `build-app`).

```ts
import type {
  IArtifactStore,
  ArtifactDestination,
  PutArtifactInput,
  PutArtifactResult,
  ArtifactMetadata,
} from '@_linked/core/interfaces/IArtifactStore';
```

Methods:

- `describeDestination()` — bucket, prefix, optional endpoint / publicBaseUrl
- `putArtifact({ key, body, contentType, cacheControl, sha256 })` — strict upload with metadata
- `statArtifact(key)` — size / checksum / content-type verification after upload

Deliberately **excludes** delete and list. Existing `IFileStore` is unchanged.
