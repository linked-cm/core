# DSL-JSON — the Linked query wire format

DSL-JSON is the **canonical, standardized representation of a Linked query**. It is the
format queries take when they cross a boundary — process to process, service to service,
or JavaScript to any other language. If you are building an endpoint, a cache, a router, a
non-JS backend, or anything that needs to send, store, or inspect a Linked query, this is
the structure you target.

> **Status.** This document specifies the compact, DSL-shaped wire format
> (`v:"1.0"`) — and the JavaScript serializer emits it: where-clauses, mutation values,
> path-keyed **mutation node data** (`__id`/`__shape`), projections (incl. computed/scoped/casts),
> and the select envelope (`sortBy` ordered array, `one`). Remaining edges are tracked in
> docs/backlog/002 (`preload`, `in`/`nin`, cross-shape context property). See report 019 for the
> implementation record.

A Linked query exists in three tiers:

| Tier | What it is | Role |
|---|---|---|
| **Builder** | the live, fluent object you construct (`Person.select(...)`, `SelectBuilder`/`CreateBuilder`/`UpdateBuilder`/`DeleteBuilder`) | the in-process working form |
| **DSL-JSON** | a plain, lossless JSON object | **the standardized wire/interop format — the subject of this document** |
| **IR** | a shape-resolved algebra | an *internal* lowering target some stores use (e.g. the built-in SPARQL store). See [intermediate-representation.md](./intermediate-representation.md). |

The builder and the IR are implementation details of the JavaScript runtime. **DSL-JSON is
the contract.** It mirrors the DSL as closely as JSON allows: property *labels* (not IRIs),
filters that read like the `.where(...)` you wrote, and lossless round-tripping back into a
builder.

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

`fromJSON` checks it with `assertWireVersion`: a mismatched **major** is rejected; a missing
`v` is tolerated (treated as the current major). Bump the major only for breaking wire changes.

## Envelopes

Two families, distinguished structurally:

- **Mutations** carry an `op` discriminator: `"create"`, `"update"`, or `"delete"`.
- **Selects** carry no `op`.

`fromJSON(json)` routes on `op` (and throws on an unrecognized `op` rather than silently
treating it as a select). Only `v` and `shape` are always present; everything else is optional.

```jsonc
{
  "v": "1.0",
  "shape": "https://linked.cm/shape/core/Person",  // target shape IRI — the routing key
  "fields": [ "name", "hobby" ],                    // projection (see Projection)
  "where":  { "name": "Alice" },                    // filter (see Conditions)
  "limit": 10, "offset": 0,
  "sortBy": [ { "name": "ASC" } ],                  // array — element order is sort precedence
  "subject": "https://ex.org/p1",                   // .for(id) — id, {$ctx}, or omitted
  "subjects": ["https://ex.org/p1"],                // .forAll([...])
  "one": true,                                      // .one()
  "minus": [ { "shape": "Employee" } ],             // .minus(...)
  "nullSubject": true                               // .for(null) — resolves to no results
}
```

## Paths

A **path** is a dotted string of property labels: `"name"`, `"bestFriend.name"`,
`"friends.friends.name"`. A path segment may end in a no-arg call: `"name.strlen()"`,
`"friends.size()"`.

A path is written **bare** wherever its slot can only be a path:

- a **condition key** — `{ "name": "Alice" }`
- a **projection field** — `"friends.friends.name"`

A path is **wrapped** as `{ "path": "a.b.c" }` only in **operand / value** slots, where a bare
string would otherwise be a **literal** (see Values). `{ "path": "…" }` also serves as the
**escape** for a property whose label collides with a reserved word (see Reserved words).

A path that crosses a **plural** relation in a condition is an **implicit `some`** (existential):
`{ "friends.name": "Moa" }` means *"has some friend named Moa"*. Use an explicit quantifier for
compound predicates or for `every`/`none` (see Conditions).

A path segment may also **narrow type** with `as(<ShapeLabel>)`, mirroring the DSL's `.as(Dog)`:
`"pets.as(Dog).guardDogLevel"`. The shape is given by its short **label**, not its IRI, to keep
the path readable. (This is the one place an argument-bearing call rides inside a path string;
it is allowed because a cast is a path operation. In a *projection* the structured form
`{ "pets": { "cast": "Dog", "fields": [ … ] } }` is preferred.)

## Projection (`fields`)

`fields` is an array, or the string `"*"` for `selectAll()` (every property of the shape). An
**omitted** `fields` is the `select()` default. Each array entry is one of:

```jsonc
"name"                                   // a leaf path (string)
"friends.friends.name"                   // a deep linear path — one chain, dotted
{ "friends": ["name", "hobby"] }         // a relation with sub-fields (array = its fields)
{ "friends": {                           // a relation with options
    "as": "buddies",                     //   alias the result key
    "where": { "hobby": "Chess" },       //   filter the related set
    "one": true,                         //   .one() — unwrap a single
    "fields": ["name"] } }               //   sub-projection
{ "pets": { "cast": "Dog",               // .as(Dog) — type narrowing (NOT alias)
            "fields": ["guardDogLevel"] } }
{ "as": "isBestie",                      // a COMPUTED field — no single underlying property
  "value": { "bestFriend": { "id": "…/p3" } } }   // value is an expression (see Values)
{ "as": "numFriends", "value": { "path": "friends.size()" } }   // aggregate as a value
```

Rule of thumb: **aliasing/optioning a real path** stays path-keyed (`{ "<path>": { "as": … } }`);
a **computed expression** uses `{ "as": …, "value": <expr> }`. An aggregate or function without
an alias projects under its dotted call string as the key (`"friends.size()"`) — alias it for a
clean result key. Because `fields` is an array, the **same relation may be projected more than
once** (different filters/aliases) without a key collision.

## Conditions (`where`) — the path-keyed object tier

A condition is an object. Its keys are **paths** (or the combinators `and`/`or`/`not`); its
values say what to test.

```jsonc
{ "name": "Alice" }                      // implicit equals
{ "name": { "equals": "Alice" } }        // explicit, same thing
{ "age":  { ">": 18 } }                  // comparison operator
{ "age":  { ">": 18, "<": 65 } }         // multiple ops on ONE path = AND (range)
{ "name": "Alice", "age": { ">": 18 } }  // multiple keys = implicit AND
{ "name": { "!=": "Bob" } }
```

Comparison keys use **symbols** (`=`, `!=`, `>`, `>=`, `<`, `<=`); everything without a symbol
uses its **method name** (`equals`, quantifiers, functions, shape methods).

**Combinators** are reserved keys:

```jsonc
{ "or":  [ { "name": "Alice" }, { "name": "Moa" } ] }
{ "not": { "hobby": "Chess" } }
{ "and": [ { "age": { ">": 18 } }, { "age": { "<": 65 } } ] }   // explicit AND when keys would collide
{ "and": [ { "friends.some": { "name": "A" } },                 // two `some` on one relation
           { "friends.some": { "name": "B" } } ] }              //   → explicit AND (keys can't repeat)
```

**Quantifiers** over a relation — the value is a sub-condition scoped to the related node:

```jsonc
{ "friends.some":  { "name": "Moa" } }
{ "friends.every": { "name": { "!=": "Bob" } } }
{ "friends.none":  { "hobby": "Chess" } }
{ "friends.some":  { "name": "Moa", "hobby": "Chess" } }        // compound predicate
{ "friends.some":  { "friends.some": { "name": "Moa" } } }      // nested
```

**Functions / aggregates in the key** (no-arg, trailing the path):

```jsonc
{ "name.strlen()": { ">": 5 } }
{ "friends.size()": { ">=": 2 } }
```

**List membership** (`in` / `nin`) takes a wrapped list — a bare array would be ambiguous with an
S-expr:

```jsonc
{ "status": { "in":  { "list": ["draft", "sent"] } } }
{ "status": { "nin": { "list": ["archived"] } } }
```

A condition **value** is: a bare scalar (literal), a recognized value-object (`{id}`, `{$ctx}`),
an **operator/method map** (`{ ">": 18 }`), a **`{list}`** (only as an `in`/`nin` operand), or an
**S-expr array** (a computed expression — next section). A value-object with reserved value-keys
(`id`, `$ctx`, `path`) is an implicit-equals **target**; an object of operator/method keys is the
operation to apply. **A bare array as an operator/method value is illegal** — lists are `{list}`,
expressions are head-symbol arrays.

The elements of an `and`/`or` list may each be a path-keyed object **or** an S-expr array (an
S-expr evaluates to a boolean and is a valid condition). Conditions on the **same path** can't
repeat as keys (JSON keys are unique) — combine them under one operator map (`{ ">":18, "<":65 }`)
or an explicit `and`.

## Expressions — the S-expr array tier

Anything that isn't a single-step condition — chained calls, arithmetic, functions-of-functions,
nullary functions — is an **array headed by an operator symbol or function name**, with operands
following. The array shape never collides with the path-keyed object tier.

```jsonc
["now"]                                   // Expr.now()  (nullary function)
["strlen", {"path":"name"}]               // strlen(name)
["+", {"path":"count"}, 1]                // count + 1
["<", ["+", ["strlen", {"path":"name"}], 10], 100]   // strlen(name) + 10 < 100
{ "birthDate": { "<": ["now"] } }         // an S-expr as a condition value
```

**Operands** are: a bare scalar (**literal**), `{ "path": "…" }` (a **property**), a nested
`[…]` (sub-expression), or `{id}` / `{$ctx}` (refs). The "bare = literal, `{path}` = property"
rule is the same as everywhere; it just appears in array form here.

Use this tier when the path-keyed tier can't express the shape (a receiver that is itself an
expression, or a chain whose intermediate steps take arguments). For the common single-step
case, prefer the path-keyed object — it reads like the DSL.

## Values

`JSON.stringify` is lossy for some values, so value slots use these forms. In **value position**
a bare scalar is always a **literal** (there is no property-vs-literal ambiguity — a property is
marked `{path}`):

| Form | Meaning |
|---|---|
| `"Alice"`, `42`, `true` | a literal string / number / boolean |
| `{ "path": "a.b.c" }` | a property / computed-path value |
| `[ "op", … ]` | a computed expression (S-expr tier) |
| `{ "id": "<iri>" }` | a node reference |
| `{ "$ctx": "user" }` / `{ "$ctx": "user", "path": "name" }` | a context reference (see below) |
| `{ "date": "<ISO-8601>" }` | a `Date` (marked — an ISO string ≈ a literal string) |
| `{ "list": [ <value>, … ] }` | a list (marked — a bare array ≈ an S-expr) |
| `{ "add"?: [<value>], "remove"?: ["<iri>"] }` | add/remove on a set relation |
| `{ "unset": true }` | clear the property (`undefined`/`null`) |
| `{ "name": "…", … }` | a nested node description (a create) |

### Computed values (mutation fields, projected `value`)

Because a mutation field is written `{ propBeingSet: value }`, the **key is the property being
written**, so a computed value must be a **self-contained expression** with its own explicit
receiver. Use a literal, `{path}`, or an S-expr — **not** the path-keyed condition form:

```jsonc
{ "guardDogLevel": ["+", {"path":"guardDogLevel"}, 1] }   // count = count + 1
{ "hobby":        { "path": "bestFriend.name.ucase()" } } // pure-path value
{ "birthDate":    ["now"] }                               // Expr.now()
```

## Context references (`{$ctx}`)

A query may refer to a value not known when it is authored — most commonly "the current user".
Instead of resolving it eagerly, the reference travels as a marker and is resolved **at lowering
time** against the resolving process's context map. `$ctx` carries *only* the context name; an
access on it uses `path` (the same dotted-path syntax):

```json
{ "$ctx": "user" }                       // the user entity
{ "$ctx": "user", "path": "name" }       // getQueryContext('user').name
```

The marker appears anywhere a node id can: the select `subject`, the update `targetId`, a delete
`id`, a mutation field value, and as a condition value or expression operand.

Resolution at lowering:

- **Mutations** must hit a concrete node — an unresolved context throws `UnresolvedContextError`.
- **Selects** never throw — an unresolved context makes `exec()` resolve to `null` (a reactive
  layer re-runs once the context lands via `subscribeQueryContext`).

## Calls (shape methods)

Pure, value-producing shape methods (computed getters / helpers) are usable in conditions,
projections, and values. A **no-arg** call rides in the path (`"fullName()"`,
`"name.strlen()"`). A call **with arguments** uses the explicit node:

```jsonc
{ "fullName()": "Alice Smith" }                          // no-arg, in the key
{ "as": "len", "value": { "path": "name.strlen()" } }    // no-arg, as a value
{ "call": "distanceTo", "args": [ { "id": "…/office" } ] }   // with args
```

Only **value-producing** methods are legal in these positions. **Side-effecting** methods
(actions / commands like `sendEmail`) are **not** valid in a filter or value; they are reserved
for a future top-level action envelope (`{ "op": "call", … }`) that reuses the same call node.
Position — not syntax — decides intent.

## Mutations

### Create

```json
{
  "v": "1.0", "op": "create", "shape": "https://linked.cm/shape/core/Person",
  "data": {
    "name": "Alice",
    "hobby": "Chess",
    "bestFriend": { "name": "Bestie" },
    "friends": [ { "id": "https://ex.org/p2" } ]
  }
}
```

`data` is a **node description**: property keys are labels (resolved against the shape), values
use the Value forms above. A nested object is a nested create; `{ "id": … }` is a reference; an
optional `"id"` on `data` fixes a predefined id.

### Update

```json
{
  "v": "1.0", "op": "update", "shape": "…/Person",
  "mode": "for", "targetId": "https://ex.org/p1",
  "data": { "hobby": "Go", "guardDogLevel": ["+", {"path":"guardDogLevel"}, 1] }
}
```

`mode` is `"for"` (single target — `targetId` is an id or `{$ctx}`), `"forAll"` (every instance),
or `"where"` (a `where` condition, same as select's).

### Delete

```jsonc
{ "v":"1.0", "op":"delete", "shape":"…", "mode":"ids",
  "ids": [ "https://ex.org/p1", { "$ctx": "user" } ] }   // ids and/or {$ctx}
{ "v":"1.0", "op":"delete", "shape":"…", "mode":"all" }
{ "v":"1.0", "op":"delete", "shape":"…", "mode":"where", "where": { "hobby": "Chess" } }
```

## Reserved words

These keys are reserved: `and`, `or`, `not`, `as`, `value`, `where`, `fields`, `cast`, `one`,
`call`, `args`, `path`, `id`, `date`, `list`, `add`, `remove`, `unset`, `some`, `every`, `none`,
`minus`, `sortBy`, `subject`, `subjects`, `op`, `shape`, `data`, `mode`, `targetId`, `ids`, `v`,
`$ctx`, and the operator symbols.

In **value / operand** position a property whose label collides is escaped with
`{ "path": "<label>" }`. **Key** position (a condition key) has no wrapper, so the three boolean
**combinators `and` / `or` / `not` are globally reserved** — a NodeShape may not declare a property
with one of those labels (enforced at shape registration). The other reserved words only matter as
path suffixes or option keys and do not collide with bare property labels.

## Producing and consuming DSL-JSON

| Direction | Call |
|---|---|
| builder → JSON | `query.toJSON()` |
| JSON → builder | `fromJSON(json)` (kind-detecting) or `SelectBuilder.fromJSON` / `CreateBuilder.fromJSON` / … |
| run an inbound query | `fromJSON(json).exec()` |
| JSON → IR (a store that wants the algebra) | `lowerMutationJSON(json)` for mutations; `lower(fromJSON(json))` for selects |

## Generating DSL-JSON with an LLM

DSL-JSON is deliberately LLM-authorable: property **labels** (not IRIs), path-keyed conditions, and
a shape that reads like the DSL. To have a model generate queries, hand it two things: a system
prompt with the grammar + rules, and the **shape context** in scope (each shape's IRI and its
properties as `label — literal(datatype) | relation(→ Target) [set]`).

A ready, copy-paste system prompt (the condensed algebra + all caveats, minus the shapes) lives at
**[dsl-json-llm-prompt.md](./dsl-json-llm-prompt.md)** — paste it, append your shapes, and the model
emits a single DSL-JSON object. Validate the output with `fromJSON(json)` before executing; the
receiver rejects unknown shapes/labels, unknown `op`, and bad wire versions, so generation mistakes
fail loud.

## Implementing DSL-JSON in another language

DSL-JSON is plain data — a non-JS service can read and write it directly. To **execute** a query
it needs the registered shapes (to resolve labels → predicates and recover cardinality) and a
translation to its own query language. The JavaScript core ships one such translation (to SPARQL,
via the IR — see [intermediate-representation.md](./intermediate-representation.md)); another
language can lower DSL-JSON straight to SQL, a graph API, etc. The IR is one reference lowering,
not part of the contract — **DSL-JSON is.**
