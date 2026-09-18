---
'@_linked/core': minor
---

Purpose-named file stores, save options and `statFile`.

- `LinkedFileStorage` gains a purpose registry: `registerPurpose`, `setStore`,
  `getStore`, `hasStore`, `listPurposes` and `accessURLFor`. `getStore(purpose)`
  returns the store configured for that purpose; a purpose that is registered but
  not configured falls back to the default store (logged once); an unregistered
  purpose throws, listing the known purposes, so a typo cannot silently write to
  the wrong store. The well-known purposes `uploads` and `appAssets` are exported
  as `FileStorePurposes` and registered at module load.
- `getDefaultDataset`/`setDefaultDataset` are renamed to
  `getDefaultStore`/`setDefaultStore`. The old names remain as `@deprecated`
  aliases that forward, so no caller has to change; they will be dropped in the
  next major.
- `IFileStore.saveFile` now takes `SaveFileOptions` (`mimeType`, `cacheControl`,
  `metadata`, `preventDuplicates`) as its third argument, still accepting a
  `string` there as the old positional `mimeType`. `normalizeSaveFileOptions` is
  exported for implementations.
- `IFileStore` gains an optional `statFile(filePath): Promise<FileStat | null>`
  for verify-after-upload. Existing implementations stay valid.
