---
"@_linked/core": minor
---

Rename `IQuadStore` → `IDataset`

The universal dataset interface is now exported as `IDataset`. This better reflects its role: every dataset in the Linked framework accepts Linked Queries as input, and the implementing class decides how to handle them (compile to SPARQL, forward to a Host Agent API, translate to SQL, etc.).

**Migration:** replace all imports of `IQuadStore` with `IDataset`:

```ts
// before
import type { IQuadStore } from '@_linked/core/interfaces/IQuadStore';
// after
import type { IDataset } from '@_linked/core/interfaces/IDataset';
```

Classes that previously `implements IQuadStore` should now `implements IDataset`. The interface contract is unchanged — `init`, `selectQuery`, `updateQuery`, `createQuery`, `deleteQuery`.
