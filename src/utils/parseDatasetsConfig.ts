// Pure parser + dispatcher for linked.{backend,frontend}.datasets.json.
//
// Per the spec in docs/backlog/016-ejection-export-flow.md:
//
//   {
//     "datasets": {
//       "<alias>": {
//         "store":  "<npm-import-path>",
//         "config": { /* passed verbatim to the store's constructor */ }
//       }
//     }
//   }
//
// `store` is an npm import path string (e.g. "@_linked/fuseki/shapes/FusekiStore").
// `config` is the store class's own concern — the runtime never inspects it.
// `${VAR}` / `${VAR:-default}` placeholders inside string values are resolved
// against an env map at parse time.

/** One entry under `datasets`. Keyed by alias name in the parent object. */
export interface DatasetEntry {
  /** npm import path to the IDataset class — e.g. "@_linked/fuseki/shapes/FusekiStore". */
  store: string;
  /** Constructor argument forwarded to the store class. Shape is store-specific. */
  config: Record<string, unknown>;
}

/** Top-level structure of linked.{backend,frontend}.datasets.json. */
export interface DatasetsConfig {
  /** Alias → store entry. */
  datasets: Record<string, DatasetEntry>;
  /** Reserved for future top-level sections (fileStorage, services, etc.). */
  [section: string]: unknown;
}

/**
 * Parse + env-resolve a raw datasets config object.
 *
 * - Requires a top-level `datasets` object (other top-level sections are passed
 *   through unchanged for future extension).
 * - Resolves `${VAR}` and `${VAR:-default}` placeholders against `env` recursively
 *   across all string leaves.
 * - Strips keys starting with `_` (treated as comments / `_note` fields).
 * - Throws on a referenced env var with no default that is unset or empty.
 */
export function parseDatasetsConfig(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): DatasetsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'Invalid datasets config: expected a top-level JSON object',
    );
  }
  const resolved = resolveInterpolations(raw, env) as Record<string, unknown>;
  const datasets = resolved.datasets;
  if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) {
    throw new Error(
      'Invalid datasets config: missing or malformed "datasets" section',
    );
  }
  for (const [alias, entry] of Object.entries(datasets)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" must be an object`,
      );
    }
    const e = entry as DatasetEntry;
    if (typeof e.store !== 'string' || !e.store) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" is missing a string "store" (npm import path)`,
      );
    }
    if (e.config !== undefined && (typeof e.config !== 'object' || Array.isArray(e.config))) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" "config" must be an object if present`,
      );
    }
    if (e.config === undefined) e.config = {};
  }
  return resolved as DatasetsConfig;
}

function resolveInterpolations(
  value: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === 'string') return resolveString(value, env);
  if (Array.isArray(value)) {
    return value.map((v) => resolveInterpolations(v, env));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.startsWith('_')) continue; // _note, _comment, ...
      out[key] = resolveInterpolations(
        (value as Record<string, unknown>)[key],
        env,
      );
    }
    return out;
  }
  return value;
}

// Matches ${VAR} or ${VAR:-default}. VAR is uppercase alphanum + underscore.
// Default text may contain anything except `}`.
const INTERP_RE = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

function resolveString(
  input: string,
  env: Record<string, string | undefined>,
): string {
  return input.replace(INTERP_RE, (_full, varName: string, defaultValue?: string) => {
    const v = env[varName];
    if (v !== undefined && v !== '') return v;
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(
      `Required env var "${varName}" is not set and has no default (referenced in datasets config)`,
    );
  });
}

/**
 * Backend-side store loader. Dynamically imports each alias's `store`
 * (an npm specifier) and instantiates the resolved class with the entry's
 * `config` verbatim — `new StoreClass(entry.config)`. Returns alias → store.
 *
 * Convention: the last segment of the `store` path is the named export to
 * use (e.g. `@_linked/fuseki/shapes/FusekiStore` → `FusekiStore`). Falls
 * back to the module's `default` export if the named export is absent.
 *
 * This helper is async + uses runtime dynamic import — works in Node where
 * the module specifier can be resolved at runtime. The frontend can't use it
 * (webpack can't bundle `import(variableString)`); frontends instead import
 * store classes explicitly in their storage-config file and instantiate per
 * alias themselves.
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
      (mod && (mod as { default?: unknown }).default);
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
