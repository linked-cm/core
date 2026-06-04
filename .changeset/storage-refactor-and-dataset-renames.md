---
'@_linked/core': minor
---

Storage refactor (`parseDatasetsConfig` + `loadStores`) and dataset-terminology renames.

**New: `parseDatasetsConfig`.** Reads `linked.<side>.datasets.json` in the new shape `{ datasets: { <alias>: { store: "<npm-path>", config: {...} } } }`, resolves `${VAR}` placeholders against the runtime environment, and returns a typed config object. Replaces the old shape that pre-baked store classes.

**New: `loadStores` (BE async dispatcher).** Given the parsed config, dynamically imports each alias's `store` package by its npm path and instantiates with the alias's `config`. Lives in its own file (`utils/loadStores.ts`) so frontend bundles can import `parseDatasetsConfig` without webpack flagging the dynamic import as a critical dependency. Frontend code hardcodes the per-alias store mapping; only backend uses `loadStores`.

**Breaking: `buildStoresFromConfig` removed.** Replaced by the `parseDatasetsConfig` + `loadStores` pair. Migration: split your call into the parse + load steps; the parsed config can be re-used by frontend code (which then imports stores statically).

**Breaking: dataset-terminology renames.** Continuing the IQuadStore → IDataset rename from 2.5.0 to public API surfaces:

```ts
// before
LinkedStorage.setDefaultStore(store);
LinkedStorage.setStoreForShapes(store, [Shape1, Shape2]);
import { SparqlStore } from '@_linked/core/datasets/SparqlStore';

// after
LinkedStorage.setDefaultDataset(dataset);
LinkedStorage.setDatasetForShapes(dataset, [Shape1, Shape2]);
import { SparqlDataset } from '@_linked/core/datasets/SparqlDataset';
```

The class is the same; the public name now reflects the "every store is a dataset" model.

**Fix: mutation-side URI resolution.** Companion to PR #77 — apply the same URI fidelity fix on the SPARQL mutation path (was previously only on the read path).

**Fix: projected optional traversals.** SPARQL execution preserves projection through optional triple patterns.

**Fix: SHACL malformed inherited property shapes guarded.** No longer throws on malformed inheritance chains; emits a warning instead.

**Internal: harden `selectQuery` + asset helpers.** Better error messages on invalid input. Test helper `findComposeFile` updated to find docker-compose test files in additional paths.
