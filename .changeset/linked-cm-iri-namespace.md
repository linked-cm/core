---
"@_linked/core": minor
---

Shape, package, and framework-vocabulary IRIs now use the canonical `linked.cm` namespace, with a configurable per-package publish root.

**New scheme (arch-aligned):**
- Shape IRIs: `https://linked.cm/shape/{packageSlug}/{ShapeName}` (PascalCase shape name; previously `https://data.lincd.org/module/{sanitized}/shape/{lowercased}`).
- Package IRIs: `https://linked.cm/pkg/{packageSlug}` (previously `…/module/{name}`).
- Framework vocabulary: `https://linked.cm/ont/linked-core/` (prefix `linked_core`; previously `https://purl.org/on/lincd/`, prefix `lincd`). The `Module` term is renamed to `Package`.

**New / changed public API:**
- `linkedPackage(name, { baseUri?, slug? })` — packages declare where they publish. `baseUri` defaults to `https://linked.cm/` (first-party); CN injects a workspace-scoped root (`{workspaceSlug}.id.create.now`) for private packages. `slug` is the clean kebab package slug used in IRIs.
- New exports `LINKED_DATA_ROOT`, `getPackageUri()`, `setPackagePublishConfig()` (replaces the removed `LINCD_DATA_ROOT`).
- The framework ontology export is now `coreOntology` (was `lincd`).

**Breaking:** generated shape/package/term IRIs change. Consumers that hardcoded `data.lincd.org` IRIs, imported `LINCD_DATA_ROOT`, or used the `lincd` ontology export must update. Stored data keyed on the old IRIs needs migration.
