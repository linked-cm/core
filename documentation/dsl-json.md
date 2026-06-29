# DSL-JSON — the Linked query wire format

DSL-JSON is the **canonical, standardized representation of a Linked query**. It is the
format queries take when they cross a boundary — process to process, service to service,
or JavaScript to any other language. If you are building an endpoint, a cache, a router, a
non-JS backend, or anything that needs to send, store, or inspect a Linked query, this is
the structure you target.

A Linked query exists in three tiers:

| Tier | What it is | Role |
|---|---|---|
| **Builder** | the live, fluent object you construct (`Person.select(...)`, `SelectBuilder`/`CreateBuilder`/`UpdateBuilder`/`DeleteBuilder`) | the in-process working form |
| **DSL-JSON** | a plain, lossless JSON object | **the standardized wire/interop format — the subject of this document** |
| **IR** | a shape-resolved algebra | an *internal* lowering target some stores use (e.g. the built-in SPARQL store). See [intermediate-representation.md](./intermediate-representation.md). |

The builder and the IR are implementation details of the JavaScript runtime. **DSL-JSON is
the contract.** It is deliberately compact (property *labels*, not full IRIs, where the
shape can recover them) and round-trips losslessly back into a builder.

```ts
import {fromJSON} from '@_linked/core';

const json = query.toJSON();           // builder → DSL-JSON (outbound)
const rebuilt = fromJSON(json);        // DSL-JSON → builder (inbound)
await rebuilt.exec();                  // run it on whatever dataset is configured
```

## Versioning

Every envelope carries a wire-format version under `v`:

```json
{ "v": "1.0", ... }
```

`fromJSON` (and every per-builder `fromJSON`) checks it with `assertWireVersion`: a mismatched
**major** version is rejected; a missing `v` is tolerated (treated as the current major). Bump
the major only for breaking wire changes.

## Envelopes

There are two envelope families, distinguished structurally:

- **Mutations** carry an `op` discriminator: `"create"`, `"update"`, or `"delete"`.
- **Selects** carry no `op`.

`fromJSON(json)` routes on `op` (and throws on an unrecognized `op` rather than silently
treating it as a select).

### Select

```jsonc
{
  "v": "1.0",
  "shape": "https://linked.cm/shape/core/Person",  // target shape IRI (the routing key)
  "fields": [ { "path": "name" }, { "path": "hobby" } ],
  "limit": 10,
  "offset": 0,
  "subject": "https://ex.org/p1",     // single-subject id, OR a {$ctx} ref (see below), OR omitted
  "subjects": ["https://ex.org/p1"],   // multi-subject ids (forAll)
  "singleResult": true,
  "orderDirection": "ASC",
  "where": { /* WherePath JSON, see below */ },
  "sortBy": { "paths": ["name"], "direction": "ASC" },
  "minusEntries": [ /* exclusions */ ],
  "nullSubject": true                  // .for(null) — resolves to no results
}
```

Only `v` and `shape` are always present; everything else is optional.

A real example — `Person.select(p => [p.name, p.hobby]).where(p => p.name.equals('Alice')).limit(10)`:

```json
{
  "v": "1.0",
  "shape": "https://linked.cm/shape/core/Person",
  "fields": [{ "path": "name" }, { "path": "hobby" }],
  "limit": 10,
  "where": {
    "kind": "expression",
    "ir": {
      "kind": "binary_expr", "operator": "=",
      "left": { "kind": "property_expr", "sourceAlias": "__ref_0__", "property": "https://linked.cm/shape/core/Person/name" },
      "right": { "kind": "literal_expr", "value": "Alice" }
    },
    "refs": { "__ref_0__": ["https://linked.cm/shape/core/Person/name"] }
  }
}
```

**Field entries** (`fields[]`) are shape-relative labels, optionally aliased, aggregated, or
nested:

```jsonc
{ "path": "name", "as": "fullName", "aggregation": "count",
  "subSelect": { "shape": "...", "fields": [ ... ] } }   // nested select for a relation
```

**Where clauses** (`where`) are one of four shapes:

- `{ "kind": "expression", "ir": <expression IR>, "refs": { ... } }` — a comparison/boolean
  expression (`.equals`, `.gt`, `.and`, …). The `ir` is the expression sub-tree; `refs` maps
  placeholder aliases back to property paths.
- `{ "kind": "andOr", "firstPath": <where>, "andOr": [ { "and": <where> }, { "or": <where> } ] }`
- `{ "kind": "exists", ... }` — an EXISTS/NOT-EXISTS over a relation (`.some()/.every()/.none()`).
- `{ "kind": "evaluation", "path": [...], "method": "...", "args": [...] }` — method-style condition.

### Create

```json
{
  "v": "1.0",
  "op": "create",
  "shape": "https://linked.cm/shape/core/Person",
  "data": {
    "shape": "https://linked.cm/shape/core/Person",
    "fields": [
      { "prop": "name",  "value": { "kind": "lit", "value": "Alice" } },
      { "prop": "hobby", "value": { "kind": "lit", "value": "Chess" } }
    ]
  }
}
```

`data` is a **node description**: a `shape`, optional `id` (predefined/fixed id), and `fields[]`
of `{ prop: <label>, value: <value> }`. Property keys are labels; the receiver resolves them
against the registered shape.

### Update

```json
{
  "v": "1.0",
  "op": "update",
  "shape": "https://linked.cm/shape/core/Person",
  "mode": "for",
  "targetId": "https://ex.org/p1",
  "data": { "shape": "...", "fields": [ { "prop": "hobby", "value": { "kind": "lit", "value": "Go" } } ] }
}
```

`mode` is `"for"` (single target — `targetId` is an id or a `{$ctx}` ref), `"forAll"` (every
instance of the shape), or `"where"` (a `where` clause, same shape as select's).

### Delete

```jsonc
// by id(s)
{ "v": "1.0", "op": "delete", "shape": "...", "mode": "ids",
  "ids": ["https://ex.org/p1", "https://ex.org/p2"] }   // each id may also be a {$ctx} ref

// all instances
{ "v": "1.0", "op": "delete", "shape": "...", "mode": "all" }

// by condition
{ "v": "1.0", "op": "delete", "shape": "...", "mode": "where", "where": { /* WherePath JSON */ } }
```

## Value encodings

`JSON.stringify` is lossy for some values (a `Date` collapses to a string, an expression is a
live object, `undefined` disappears), so each node-field value is a **tagged** object:

| `kind` | Shape | Meaning |
|---|---|---|
| `lit` | `{ "kind": "lit", "value": string \| number \| boolean }` | a literal |
| `date` | `{ "kind": "date", "value": "<ISO-8601>" }` | a `Date` |
| `ref` | `{ "kind": "ref", "id": "<iri>" }` | a node reference |
| `ctxRef` | `{ "kind": "ctxRef", "name": "<context>" }` | a query-context reference (see below) |
| `node` | `{ "kind": "node", "data": <node description> }` | a nested create |
| `array` | `{ "kind": "array", "items": [ <value>, ... ] }` | a list |
| `setMod` | `{ "kind": "setMod", "add"?: [<value>], "remove"?: ["<iri>"] }` | add/remove on a set relation |
| `expr` | `{ "kind": "expr", "ir": <expression IR>, "refs"?: {...} }` | a computed update (e.g. `p => p.count.plus(1)`) |
| `unset` | `{ "kind": "unset" }` | clear the property (`undefined`/`null`) |

## Context references (`{$ctx}`)

A query may refer to a value that isn't known when it is authored — most commonly "the current
user". Instead of resolving it eagerly (which would bake in a stale id, or fail before login),
the reference travels on the wire as a marker and is resolved **at lowering time** against
whatever context map the resolving process has:

```json
{ "$ctx": "user" }
```

The marker appears anywhere a node id can: the select `subject`, the update `targetId`, a delete
`id`, and mutation field values (as the `ctxRef` value kind). Inside a where-clause expression it
appears as a `contextName` on the reference node (`{ "kind": "reference_expr", "contextName": "user" }`).

Resolution rules at lowering:

- **Mutations** must hit a concrete node — an unresolved context throws `UnresolvedContextError`.
- **Selects** never throw — an unresolved context makes `exec()` resolve to `null` (a reactive
  layer re-runs the query once the context lands via `subscribeQueryContext`).

Example — `Person.select(p => p.name).for(getQueryContext('user'))`:

```json
{
  "v": "1.0",
  "shape": "https://linked.cm/shape/core/Person",
  "fields": [{ "path": "name" }],
  "subject": { "$ctx": "user" },
  "singleResult": true
}
```

## Producing and consuming DSL-JSON

| Direction | Call |
|---|---|
| builder → JSON | `query.toJSON()` |
| JSON → builder | `fromJSON(json)` (kind-detecting) or `SelectBuilder.fromJSON` / `CreateBuilder.fromJSON` / … |
| run an inbound query | `fromJSON(json).exec()` |
| JSON → IR (a store that wants the algebra) | `lowerMutationJSON(json)` for mutations; `lower(fromJSON(json))` for selects |

## Implementing DSL-JSON in another language

DSL-JSON is plain data — a non-JS service can read and write it directly. To **execute** a query
it needs the registered shapes (to resolve labels → predicates and recover cardinality) and a
translation to its own query language. The JavaScript core ships one such translation (to SPARQL,
via the IR — see [intermediate-representation.md](./intermediate-representation.md)); another
language can lower DSL-JSON straight to SQL, a graph API, etc. The IR is one reference lowering,
not part of the contract — **DSL-JSON is.**
