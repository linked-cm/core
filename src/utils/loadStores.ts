// Backend-side store loader. Lives in its own file so that frontend
// bundlers (webpack) consuming parseDatasetsConfig don't pull in the
// dynamic-import code below — webpack flags `import(variableString)` as
// a critical dependency when it can't analyse the target statically.
//
// Backends import this directly; frontends never do.

import type {DatasetsConfig} from './parseDatasetsConfig.js';

/**
 * Dynamically imports each alias's `store` (an npm specifier) and
 * instantiates the resolved class with the entry's `config` verbatim —
 * `new StoreClass(entry.config)`. Returns alias → store.
 *
 * Convention: the last segment of the `store` path is the named export
 * to use (e.g. `@_linked/fuseki/shapes/FusekiStore` → `FusekiStore`).
 * Falls back to the module's `default` export if the named export is
 * absent.
 *
 * Async + uses runtime dynamic import; works in Node where the module
 * specifier can be resolved at runtime. Frontends should instead
 * import each store class explicitly in their storage-config file and
 * instantiate per alias by hand.
 */
export async function loadStores<T = unknown>(
  config: DatasetsConfig,
): Promise<Record<string, T>> {
  const stores: Record<string, T> = {};
  for (const [alias, entry] of Object.entries(config.datasets)) {
    const mod = await import(entry.store);
    const exportName = entry.store.split('/').pop()!;
    const StoreClass =
      (mod && (mod as Record<string, unknown>)[exportName]) ??
      (mod && (mod as {default?: unknown}).default);
    if (typeof StoreClass !== 'function') {
      throw new Error(
        `loadStores: could not resolve a class export from "${entry.store}" for alias "${alias}". ` +
          `Expected a named export "${exportName}" or a default export that is a class.`,
      );
    }
    stores[alias] = new (StoreClass as new (cfg: unknown) => T)(entry.config);
  }
  return stores;
}
