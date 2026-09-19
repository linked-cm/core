---
'@_linked/core': minor
---

Purpose-named file stores, save options and `statFile`.

- `LinkedFileStorage` gains a purpose registry: `registerPurpose`, `setStore`,
  `getStore`, `hasStore`, `listPurposes` and `accessURLFor`. `getStore(purpose)`
  returns the store configured for that purpose; a purpose that is registered
  but not configured falls back to the default store (noted once with
  `console.debug`); an unregistered
  purpose throws, listing the known purposes, so a typo cannot silently write to
  the wrong store. The well-known purposes `uploads` and `appAssets` are exported
  as `FileStorePurposes` and registered at module load. `uploads` is an ordinary
  purpose: `setDefaultStore` configures no purpose of its own, so `uploads`
  resolves to the default store as a fallback, `hasStore('uploads')` is true only
  after an explicit `setStore('uploads', store)`, and that call has the same
  effect whether it runs before or after `setDefaultStore`.
- `getDefaultDataset`/`setDefaultDataset` are renamed to
  `getDefaultStore`/`setDefaultStore`. The old names remain as `@deprecated`
  aliases that forward, so no caller has to change; they will be dropped in the
  next major.
- `IFileStore.saveFile` now takes `SaveFileOptions` (`mimeType`, `cacheControl`,
  `metadata`, `preventDuplicates`) as its third argument, still accepting a
  `string` there as the old positional `mimeType`. `normalizeSaveFileOptions` is
  exported for implementations; it reports `preventDuplicates` as `undefined`
  when the caller did not specify one — there is no core-wide default, so each
  store keeps applying its own (`S3FileStore` overwrites, `LocalFileStore` adds a
  random suffix). `options.preventDuplicates` wins over the positional argument.
  `LinkedFileStorage.saveFile` likewise forwards an unspecified
  `preventDuplicates` as `undefined` rather than `false`, so a
  `saveFile(path, bytes)` call keeps behaving exactly as before.
- `IFileStore` gains an optional `statFile(filePath): Promise<FileStat | null>`
  for verify-after-upload. Existing implementations stay valid.
