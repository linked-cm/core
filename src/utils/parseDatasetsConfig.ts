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
 * Factory keyed by the npm-import-path string in a DatasetEntry's `store` field.
 * Each factory receives the entry's `config` (verbatim, env-resolved) and the alias name,
 * and returns the constructed store instance.
 */
export type DatasetFactories<T = unknown> = Record<
  string,
  (config: Record<string, unknown>, alias: string) => T
>;

/**
 * Walk a parsed DatasetsConfig and construct one store per alias by
 * dispatching on `entry.store` (the npm import path). Returns alias → store.
 * Throws if any alias references a store path that has no factory provided.
 *
 * The two-step pattern (parse, then build) exists so the JSON spec stays
 * stable (per 016) while the TS code on each runtime side decides which
 * stores it actually imports — keeps the loader free of cross-package
 * dependencies on every possible store class.
 */
export function buildStoresFromConfig<T = unknown>(
  config: DatasetsConfig,
  factories: DatasetFactories<T>,
): Record<string, T> {
  const stores: Record<string, T> = {};
  for (const [alias, entry] of Object.entries(config.datasets)) {
    const factory = factories[entry.store];
    if (!factory) {
      throw new Error(
        `No factory registered for store "${entry.store}" (alias "${alias}"). Pass a factory keyed by the same npm import path in the second argument to buildStoresFromConfig.`,
      );
    }
    stores[alias] = factory(entry.config, alias);
  }
  return stores;
}
