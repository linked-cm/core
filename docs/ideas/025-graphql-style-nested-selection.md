---
summary: Compare the Linked query DSL with GraphQL (working-draft spec + graphql-js 17, released June 2026) feature by feature, and propose a GraphQL-style declarative selection syntax as a NEW OVERLOAD of `Shape.select(...)` — a nested object-literal query tree where fields are bare keys, verbs are `$`-prefixed options, and filters reuse the existing DSL-JSON condition grammar — plus an optional in-house (no-dependency) GraphQL-text parser and a longer-term GraphQL endpoint generated from SHACL shapes. Everything lowers to the existing DSL-JSON wire format.
packages: [core]
---

# GraphQL-style nested selection — Ideation

## Context

The chainable DSL is precise and fully typed, but deeply nested selections get
verbose: every level of nesting needs a `.select((x) => [...])` callback with a
fresh lambda parameter, and options (`where`, `limit`, `orderBy`) are method
chains interleaved with the projection. GraphQL solved exactly this ergonomics
problem: a selection is a *declarative tree that mirrors the shape of the
result*. This document compares the two feature-by-feature and proposes how to
get GraphQL's ergonomics without giving up the things the Linked DSL does that
GraphQL cannot (filters, expressions, nested pagination, typed mutations).

Reference points for the comparison (two things carry "GraphQL" version numbers
and it's worth keeping them apart):

- **graphql-js** — the reference JS implementation. `17.0.0` shipped
  **2026-06-15**, `17.0.1` on **2026-06-16** (weeks old at time of writing;
  `16.14.x` still patched in parallel). v17's headline is that **incremental
  delivery (`@defer` / `@stream`) is now in the stable release**, plus a
  rewritten executor. The query *language* it implements is essentially stable.
- **The spec editions** — the dated formal releases (the "October 2021"-style
  tags) lag the library. New language lands in the **working draft**
  (graphql/graphql-spec `main`, fetched 2026-07 — `@oneOf` input objects, schema
  coordinates, type-system descriptions) before an edition is cut. Subscriptions
  are in the ratified spec (§6.3); `@defer`/`@stream` are still RFC-stage there
  despite shipping in graphql-js 17.

GraphQL's own design principles (from the spec Overview) frame why this proposal
exists — two of them are exactly our motivation:

> **Hierarchical**: a GraphQL request is structured hierarchically — *the request
> is shaped just like the data in its response.*
> **Client-specified response**: the client specifies exactly what it consumes,
> at field-level granularity.

## Part 1 — Feature comparison: GraphQL vs `@_linked/core`

### 1.1 Where the concepts line up

| GraphQL (spec section) | `@_linked/core` today | Notes |
|---|---|---|
| Selection sets & fields (§2.4–2.5) | `select((p) => [...])` paths, sub-`select`, `selectAll()` | Same purpose; Linked's form is imperative callbacks, GraphQL's is a declarative tree. |
| Field arguments (§2.6) | `where` / `limit` / `offset` / `orderBy` on sub-selects | GraphQL args are schema-defined and *opaque* (the server decides what `first: 10` means). Linked's are a fixed, universal vocabulary — closer to what most GraphQL servers reinvent per-field. |
| Field alias (§2.7) | Custom result objects `select(p => ({buddy: p.bestFriend}))`; DSL-JSON `{"friends": {"as": "buddies"}}` | Already supported, two spellings. |
| Fragments (§2.8) | `FieldSet` (`FieldSet.for/all/add/remove/pick/merge`, serializable) | `FieldSet` ≈ named fragment. Composition (`merge`) is actually richer than fragment spreads. |
| Inline fragments / type conditions (§2.8.2) | `.as(Dog)` cast; DSL-JSON `{"pets": {"cast": "Dog", "fields": [...]}}` | Same semantics: narrow a polymorphic edge to a subtype and select subtype fields. |
| Variables (§2.10) | Query context (`setQueryContext` / `getQueryContext`, `{$ctx}` marker in DSL-JSON) | Context covers "ambient" values (current user). There is **no generic per-query variables mechanism** — a real gap for cached/parameterized queries. |
| Directives `@skip` / `@include` (§3.13) | — | No conditional field inclusion. Callers build the field list programmatically instead (`FieldSet.add/remove`), which covers the use case but isn't expressible *inside* one serialized query. |
| Mutations (§3.3.2, serial execution §6.2.2) | `create` / `update` / `delete` + builders, expression updates, bulk, conditional, set `add`/`remove` | Linked is *far more specified* here: GraphQL says nothing about what a mutation does — every server invents its own input conventions. Linked's mutation semantics are part of the contract. |
| Subscriptions (§6.3, source/response streams) | — (only reactive re-run via `subscribeQueryContext`) | Genuine gap if live queries are wanted. Out of scope for this proposal. |
| Type system: object types, non-null, lists (§3) | Shape classes: `@literalProperty` / `@objectProperty`, `required`, `maxCount`, datatypes | SHACL is the schema language; `maxCount: 1` ≈ non-list, `required` ≈ non-null. |
| Interfaces / unions (§3.7–3.8) | Shape inheritance (`Employee extends Person`, tighten-only overrides) | Inheritance covers interfaces. No union-of-unrelated-shapes concept. |
| Enums (§3.9) | — (plain literals + SHACL `in` constraints not surfaced) | Gap, minor. |
| Custom scalars / `@specifiedBy` (§3.5) | xsd datatypes with automatic coercion (`xsd:dateTime` → `Date`, etc.) | RDF datatypes are the richer system. |
| `@oneOf` input objects (draft §3.10.1) | — | Niche; input polymorphism. |
| Introspection (`__schema`, `__typename`, §4) | Shape registry + SHACL shape metadata (can be synced to the store) | The raw material exists; there is no standard *query-time* introspection surface. |
| Validation (§5) | DSL-JSON label validation against the target shape; compile-time type checking in TS | Different layers, same goal. TS inference is stronger than anything GraphQL offers without codegen. |
| Response format, field errors, partial results (§7) | Typed results; `DeleteResponse {deleted, count, failed?, errors?}` | GraphQL's `{data, errors[]}` envelope with path-addressed partial failures is more formalized. |
| `@defer` / `@stream` (RFC; shipped in graphql-js 17) | — | Incremental delivery; out of scope. |
| Schema coordinates (draft) | Full property IRIs | IRIs already are globally unique coordinates. |

### 1.2 Where Linked is ahead of GraphQL

Worth stating explicitly, because the proposal must not regress these:

1. **Filtering** — GraphQL has *no* standard filter language. `where` with
   `equals/gt/contains/some/every/and/or/not` is something every GraphQL server
   (Hasura, Prisma, PostGraphile) had to invent as a nonstandard convention.
   DSL-JSON's path-keyed conditions (`{"age": {">": 18}}`, `{"friends.some":
   {"name": "Moa"}}`) already are that language.
2. **Computed expressions** — `p.name.strlen()`, `p.age.plus(10).times(2)`,
   `Expr.ifThen(...)`. GraphQL fields are opaque server resolvers; there is no
   client-side expression algebra at all.
3. **Nested pagination & sorting** — `p.friends.select(f => f.name).orderBy('name').limit(5)`
   per nesting level. GraphQL needs per-field argument conventions (Relay
   connections) and server support.
4. **Set quantifiers** — `some` / `every` / `none` over relations.
5. **Exclusion** — `.minus(...)` (by shape, property, condition, nested path).
6. **Specified mutations** — patch semantics, `add`/`remove` on multi-value
   properties, expression updates, conditional/bulk — all portable in DSL-JSON.
7. **End-to-end type inference without codegen** — GraphQL clients need a
   codegen step (TypedDocumentNode) for what `Person.select(p => p.knows.name)`
   infers natively.
8. **One round trip, no N+1** — the whole tree lowers to a single query (IR →
   SPARQL). Naive GraphQL executes one resolver per field.

### 1.3 Genuine gaps GraphQL exposes

1. **A declarative selection tree.** The chainable DSL scales badly with
   nesting depth (see 2.1). *This is the core of the proposal.*
2. **Per-query variables.** `($minAge: Int)` — serialize once, execute many
   times with different bindings. Context (`$ctx`) only covers ambient values.
3. **Conditional inclusion** (`@include(if:)` / `@skip(if:)`) inside one
   serialized query.
4. **Standard introspection** — "what can I select on `Person`?" as a query.
5. **Operation naming** — useful for logging/caching/persisted queries.
6. Subscriptions and incremental delivery (acknowledged; not in this proposal).

## Part 2 — The pain, concretely

The scenario from the request: a person → their friends → several properties of
each friend, some of which are themselves nested objects/arrays.

### 2.1 Today: chainable DSL

```typescript
const result = await Person.select((p) => [
  p.name,
  p.birthDate,
  p.knows
    .select((f) => [
      f.name,
      f.hobby,
      f.bestFriend.select((b) => [b.name, b.birthDate]),
      f.pets.as(Dog).select((d) => [d.name, d.guardDogLevel]),
    ])
    .where((f) => f.hobby.equals('Chess').and(f.name.strlen().gt(3)))
    .orderBy('name', 'ASC')
    .limit(10),
])
  .where((p) => p.name.startsWith('A'))
  .limit(20);
```

Four lambda parameters (`p`, `f`, `b`, `d`), options method-chained onto the
middle of the projection, and the visual shape of the query does not match the
shape of the result. It is powerful and fully typed — but as a *reading and
writing* experience for deep trees, GraphQL wins:

```graphql
{
  people(where: {name: {startsWith: "A"}}, limit: 20) {
    name
    birthDate
    knows(where: {hobby: "Chess"}, orderBy: name, limit: 10) {
      name
      hobby
      bestFriend { name birthDate }
      pets { ... on Dog { name guardDogLevel } }
    }
  }
}
```

### 2.2 Today: DSL-JSON is already 80% of the way there

Notably, the wire format the library already standardizes on is *itself* a
declarative tree:

```jsonc
{
  "v": "1.0",
  "shape": "https://schema.org/Person",
  "where": { "name": { "startsWith": "A" } },
  "limit": 20,
  "fields": [
    "name",
    "birthDate",
    { "knows": {
        "where": { "hobby": "Chess" },
        "sortBy": [{ "path": "name", "dir": "ASC" }],
        "limit": 10,
        "fields": [
          "name",
          "hobby",
          { "bestFriend": ["name", "birthDate"] },
          { "pets": { "cast": "Dog", "fields": ["name", "guardDogLevel"] } }
        ] } }
  ]
}
```

So the proposal is **not** "add a second query model." It is: give DSL-JSON's
tree a first-class, *typed* TypeScript authoring surface (and optionally a
GraphQL-text parser), so users can write the tree directly instead of driving
the chainable builder to produce it.

## Part 3 — Proposal

Three tiers, independent, each lowering to DSL-JSON. Tier 1 is the
recommendation; Tiers 2–3 are follow-ups that reuse Tier 1's machinery.

### Tier 1 (recommended): typed object-literal selection — a NEW OVERLOAD of `Shape.select(...)`

**Decision (resolved): overload `select`, do not add a new method.** The two
forms are runtime-distinguishable — `typeof arg === 'function'` is today's
callback form, a plain object is the new declarative form — and the `$`-sigil
rule below guarantees the object form's keys never collide with property names,
so the overloaded typings stay tractable. `select(fn)` is 100% unchanged.

`select(selection)` accepts a nested selection object shaped like the result.
Field keys mirror the shape's decorated properties; `$`-prefixed keys carry
options — the sigil keeps options unambiguous from property names (mirroring how
MongoDB/Prisma solve the same collision) and maps 1:1 onto DSL-JSON's option
keys.

```typescript
const result = await Person.select({
  $where: { name: { startsWith: 'A' } },
  $limit: 20,

  name: true,
  birthDate: true,
  knows: {
    $where: { hobby: 'Chess', name: { strlen: { '>': 3 } } },
    $orderBy: 'name',
    $limit: 10,

    name: true,
    hobby: true,
    bestFriend: { name: true, birthDate: true },
    pets: { $as: Dog, name: true, guardDogLevel: true },
  },
});
```

The query reads top-to-bottom in the shape of the result, exactly like
GraphQL — with filters, sorting, and nested pagination that GraphQL itself
cannot express without server-specific conventions.

**Result type is inferred**, same guarantee as the chainable DSL:

```typescript
/* result: {
  id: string;
  name: string;
  birthDate: Date;
  knows: {
    id: string;
    name: string;
    hobby: string;
    bestFriend: { id: string; name: string; birthDate: Date };
    pets: { id: string; name: string; guardDogLevel: number }[];
  }[];
}[] */
```

#### Selection value grammar

For a key `K` that is a decorated property of the shape:

| Value | Meaning | DSL-JSON lowering |
|---|---|---|
| `true` | select the property (leaf, or object as `{id}` ref) | `"K"` |
| `false` / `undefined` | not selected | — |
| `{...}` (nested selection) | sub-select on the relation | `{ "K": { "fields": [...] , ...options } }` |
| `'*'` | `selectAll()` at that level | expansion of all decorated fields |

`$`-options allowed in any nested selection object:

| Option | Chainable equivalent | DSL-JSON |
|---|---|---|
| `$where: Condition` | `.where(fn)` | `where` (path-keyed condition grammar, reused as-is) |
| `$orderBy: 'name' \| {path, dir}` | `.orderBy(...)` | `sortBy` |
| `$limit` / `$offset` | `.limit()` / `.offset()` | `limit` / `offset` |
| `$one: true` | `.one()` | `one` |
| `$as: Dog` | `.as(Dog)` | `cast` |
| `$key: 'buddies'` | custom result object key | `as` (alias) |
| `$minus` | `.minus(...)` | `minus` |
| `$count: true` | `.size()` | aggregate projection |

Top level additionally accepts `$for: {id}` / `$forAll: [...]` (subject
targeting) and `$vars` (below).

**`$where` reuses the DSL-JSON condition grammar verbatim** — path-keyed
conditions, `and`/`or`/`not` combinators, quantifiers, and the S-expression
tier for computed expressions:

```typescript
$where: {
  and: [
    { age: { '>': 18, '<': 65 } },
    { 'friends.some': { name: 'Moa' } },
    ['>', ['strlen', { path: 'name' }], 3],   // expression tier
  ],
}
```

No new condition language; one grammar shared by the wire format and the typed
surface. (Typed helpers for the expression tier can come later; the chainable
`select` remains the fully-typed home for heavy expression work.)

#### Disambiguation: how selection, options, and filters never collide

The obvious worry: `name: { startsWith: 'A' }` — is `{ startsWith: 'A' }` a
*sub-selection* of `name`, or a *filter* on `name`? (`name` is a string, and
`startsWith` is one of its filter methods.) Three rules keep every position
unambiguous, and they're why overloading `select` is safe:

**Rule 1 — the `$` sigil splits fields from verbs.** In a selection object, any
key starting with `$` is an *option/verb* (`$where`, `$limit`, `$orderBy`,
`$as`, `$if`, `$count`, …); every other key is a *field name* that must be a
decorated property of the shape. A SHACL property can never start with `$`, so
there is zero collision between the two namespaces.

**Rule 2 — in *selection* position a field value is `true` or a nested
selection, never a filter.** `name: true` selects the leaf. `name: { … }` is
only legal when `name` is an *object* property (then `{…}` is its sub-selection);
for a string leaf it is a compile-time type error. **Filters never appear in
selection position** — they live only under the reserved `$where` key:

```typescript
Person.select({
  name: true,                            // selection: leaf → `true`
  $where: { name: { startsWith: 'A' } }, // filter: under the reserved $where key
});
```

Because the filter is namespaced under `$where`, `name: true` (project) and
`name: { startsWith }` (filter) sit in disjoint subtrees. Nothing to confuse.

**Rule 3 — inside `$where`, the existing DSL-JSON condition grammar
disambiguates path-vs-operator by a reserved vocabulary** (reused verbatim, see
`documentation/dsl-json.md`):

- the **outer** key is a *path* or a combinator (`and`/`or`/`not`);
- the **value** is a bare scalar (implicit `equals`) or an **operator/method
  map** whose keys are a reserved set — comparison **symbols** (`=`, `!=`, `>`,
  `>=`, `<`, `<=`) and **method names** (`equals`, `startsWith`, `contains`,
  `strlen`, quantifiers…).

So `{ name: { startsWith: 'A' } }` reads as *path `name` → method `startsWith`
with arg `'A''`* — `startsWith` is a reserved operator, not a sub-path. Genuine
nested-*path* conditions use **dotted** keys (`{ 'bestFriend.name': 'Moa' }`, or
the quantifier form `{ 'knows.some': { name: 'Moa' } }`), so a nested-object
condition is always visibly a dotted path, never bare method words. The only way
to collide is a SHACL property literally named `startsWith`, which is unlikely
and independently resolvable.

Net: **projection = bare keys → `true`/nested-objects; verbs = `$`-options;
filtering = `$where` + operator-keyed maps.** The `$` sigil keeps verbs out of
the field namespace, and `$where` keeps conditions out of the projection.

#### `and` / `or` / `not`

Reuse the condition combinators directly — they are reserved keys inside
`$where`:

```typescript
// implicit AND — multiple keys in one condition object
$where: { hobby: 'Chess', age: { '>': 18 } }

// explicit OR
$where: { or: [ { name: 'Alice' }, { name: 'Moa' } ] }

// explicit AND — needed when keys would otherwise collide (two filters, one relation)
$where: { and: [
  { 'knows.some': { name: 'Alice' } },
  { 'knows.some': { name: 'Bob' } },
] }

// NOT, and a nested boolean tree
$where: { not: { hobby: 'Chess' } }
$where: { and: [
  { age: { '>': 18, '<': 65 } },                     // range = AND on one path
  { or: [ { hobby: 'Chess' }, { hobby: 'Go' } ] },
] }
```

Same grammar the wire format already speaks — nothing new to learn, and it
round-trips through `toJSON()` / `fromJSON()` unchanged.

#### Aliases (GraphQL §2.7)

GraphQL allows the same field twice under different keys. Object literals can't
repeat a key, so aliases go the other way — alias key, `$path` pointing at the
property:

```typescript
const r = await Person.select({
  name: true,
  chessFriends:  { $path: 'knows', $where: { hobby: 'Chess' },  name: true },
  soccerFriends: { $path: 'knows', $where: { hobby: 'Soccer' }, name: true },
});
```

This also delivers "duplicate projection fields" (idea 023) for free.

#### Fragments (GraphQL §2.8) — `FieldSet` spread

`FieldSet` already is the fragment concept; let it spread into a selection:

```typescript
const personCard = FieldSet.for(Person, ['name', 'hobby']);

const r = await Person.select({
  ...personCard.spread(),          // like ...PersonCard in GraphQL
  knows: { ...personCard.spread(), $limit: 5 },
});
```

(`spread()` returns the plain selection-object form of the FieldSet; a
`$fragments: [personCard]` array form is the serializable alternative for
DSL-JSON transport.)

#### Variables (GraphQL §2.10) — new, also lands in DSL-JSON

The one genuinely new wire-format feature this proposal needs. `$var` markers
parallel to the existing `{$ctx}` markers, plus a `vars` envelope key:

```typescript
const friendsOf = Person.select({
  $where: { name: { $var: 'name' } },
  knows: { name: true, $limit: { $var: 'max' } },
});

const a = await friendsOf.bind({ name: 'Alice', max: 10 });
const b = await friendsOf.bind({ name: 'Bob',   max: 3 });
```

```jsonc
// DSL-JSON: declared once, bound at execution
{ "v": "1.1", "shape": ".../Person",
  "vars": { "name": { "type": "string" }, "max": { "type": "integer", "default": 10 } },
  "where": { "name": { "$var": "name" } },
  "fields": [ { "knows": { "limit": { "$var": "max" }, "fields": ["name"] } } ] }
```

This is what makes persisted/cached/parameterized queries possible — serialize
the tree once, POST `{query, vars}` many times. Resolution happens at the same
stage `$ctx` resolves today.

#### Conditional inclusion (`@include` / `@skip`) — `$if`

```typescript
const r = await Person.select({
  name: true,
  birthDate: { $if: { $var: 'withDetails' } },   // @include(if: $withDetails)
  knows: { $if: { $var: 'withFriends' }, name: true },
});
```

Lowers to a DSL-JSON field option `"if"`. For ad-hoc TS queries this is mere
convenience (spread a conditional), but for *serialized* queries (CMS-defined,
persisted) it is the only way to make one stored query serve several views.

#### Introspection (GraphQL §4)

The shape registry already knows everything. Expose it as a query, so a
generic client (query editor, admin UI, LLM) can discover the schema over the
same channel it queries data:

```typescript
const meta = await introspect(Person);
/* { shape: '.../Person', properties: [
     { label: 'name',  kind: 'literal', datatype: 'xsd:string', maxCount: 1, required: true },
     { label: 'knows', kind: 'object',  shape: '.../Person' },
   ] } */
```

DSL-JSON: `{ "v": "1.1", "introspect": "https://schema.org/Person" }`. This is
mostly a formatting layer over `NodeShape.getUniquePropertyShapes()`.

#### Type inference sketch

The same recursive mapped-type approach the chainable DSL uses, driven by the
literal type of the selection object:

```typescript
type Selection<S extends Shape> = SelectionOptions<S> & {
  [K in PropertyLabels<S>]?: PropertyKind<S, K> extends 'literal'
    ? boolean
    : boolean | Selection<RelatedShape<S, K>>;
};

type QueryResult<S extends Shape, Q extends Selection<S>> = { id: string } & {
  [K in SelectedKeys<Q> & PropertyLabels<S>]:
    Q[K] extends object
      ? Cardinality<S, K> extends 'one'
        ? QueryResult<RelatedShape<S, K>, Q[K]>
        : QueryResult<RelatedShape<S, K>, Q[K]>[]
      : PropertyValueType<S, K>;
};

static query<S extends Shape, const Q extends Selection<S>>(
  this: ShapeClass<S>, q: Q,
): Promise<QueryResult<S, Q>[]>;
```

`const Q` (TS 5 const type parameters) preserves the literal tree; `$`-keys are
excluded from `SelectedKeys`. `$as` narrows `RelatedShape`; `$one`/`$for`
unwrap the array; `$count: true` maps the key to `number`. The existing
`QueryResponseToResultType` machinery already solves the hard cardinality/
datatype cases — this reuses it with a different input encoding.

#### Implementation shape

`select(selection)` does **not** grow a second pipeline. It compiles the
selection object directly to DSL-JSON (it is nearly isomorphic already) and
hands it to `fromJSON(...)` → existing builder → existing IR/lowering. New code
is: the selection→DSL-JSON normalizer, the `Selection`/`QueryResult` types, and
(for variables/`$if`/introspection) small DSL-JSON v1.1 additions with their
IRDesugar handling. Everything downstream — IR, SPARQL, result mapping,
`LinkedStorage` routing — is untouched.

### Tier 2 (optional, no dependency): GraphQL text via an in-house parser

For people/tools that want to write *actual* GraphQL syntax — LLMs emit it
fluently, editors highlight it, and a CMS can store it as text. **This stays
dependency-free: we parse the subset ourselves, we do not pull in `graphql`.**

```typescript
import { gql } from '@_linked/core/graphql';

const result = await gql`{
  Person(where: {name: {startsWith: "A"}}, limit: 20) {
    name
    birthDate
    knows(where: {hobby: "Chess"}, orderBy: name, limit: 10) {
      name
      hobby
      bestFriend { name birthDate }
      pets { ... on Dog { name guardDogLevel } }
    }
  }
}`;
```

- Root field name resolves to a registered shape (label or IRI); arguments map
  to the same `$`-options; `... on Dog` → `cast`; named fragments → `FieldSet`;
  GraphQL variables → the Tier-1 `vars` envelope; `@include`/`@skip` → `$if`.
- A small in-house recursive-descent parser for the query subset we support
  (selection sets, arguments, aliases, inline fragments, named fragments,
  variables, `@include`/`@skip`) emits **DSL-JSON**, so execution is Tier 1's
  path. No `graphql` dependency — the trade-off is that we track only the subset
  we choose, not the whole evolving spec.
- Trade-off, stated honestly: template strings lose result-type inference
  (GraphQL clients need codegen for this; we would too). Tier 2 is therefore a
  *convenience/interop* surface, not a replacement for Tier 1 — which is exactly
  why Tier 1 (typed, no parser) is the recommended primary surface.

### Tier 3 (later): a real GraphQL endpoint from SHACL shapes

For interop with the GraphQL ecosystem (Apollo/Relay clients, GraphiQL,
federation):

1. **SDL generation** — Shape registry → GraphQL SDL. `Person` →
   `type Person { id: ID!, name: String!, knows: [Person!]! }`; inheritance →
   interfaces; per-relation filter/order/limit args generated from the
   condition grammar (the Hasura pattern, but derived from SHACL instead of
   hand-written).
2. **Executor** — implement one root resolver that converts an entire GraphQL
   selection set (from the resolver's `resolveInfo` AST) into a single DSL-JSON
   query — *not* per-field resolvers, so the no-N+1 property is preserved and
   the whole tree still becomes one SPARQL query.
3. Introspection, GraphiQL, persisted queries then come for free from the
   ecosystem.

Serving *real* GraphQL-over-HTTP is the one place a `graphql`(-js) server
dependency is unavoidable — so it is **quarantined to this separate,
opt-in `@_linked/graphql` package**. `@_linked/core` itself stays
dependency-free; nobody pays for graphql-js unless they install Tier 3. This
package needs Tier 1's
variables work first. It is the full answer to "GraphQL support"; Tiers 1–2
are the answer to "GraphQL ergonomics."

## Part 4 — Side-by-side summary

The same query in all four forms:

**Chainable DSL (today)**
```typescript
Person.select((p) => [
  p.name,
  p.knows.select((f) => [f.name, f.hobby, f.bestFriend.select((b) => b.name)])
    .where((f) => f.hobby.equals('Chess'))
    .limit(10),
]).where((p) => p.name.startsWith('A'));
```

**Object-literal `select` overload (Tier 1 — proposed)**
```typescript
Person.select({
  $where: { name: { startsWith: 'A' } },
  name: true,
  knows: {
    $where: { hobby: 'Chess' }, $limit: 10,
    name: true, hobby: true,
    bestFriend: { name: true },
  },
});
```

**GraphQL text (Tier 2 — proposed)**
```graphql
{ Person(where: {name: {startsWith: "A"}}) {
    name
    knows(where: {hobby: "Chess"}, limit: 10) {
      name hobby bestFriend { name }
    } } }
```

**DSL-JSON (today — unchanged, the common target)**
```jsonc
{ "v": "1.0", "shape": ".../Person",
  "where": { "name": { "startsWith": "A" } },
  "fields": ["name", { "knows": {
    "where": { "hobby": "Chess" }, "limit": 10,
    "fields": ["name", "hobby", { "bestFriend": ["name"] }] } }] }
```

## Part 5 — What this does NOT change

- `select()` chainable DSL: untouched, remains the home of computed
  expressions, `Expr`, expression updates, and the most precise typing.
- Mutations: untouched (already stronger than GraphQL's unspecified mutations).
  A later `Shape.mutate({...})` object form could mirror Tier 1 if wanted.
- IR / SPARQL pipeline: untouched. Everything lowers through DSL-JSON.
- No subscriptions / `@defer` / `@stream` in this proposal.

## Resolved decisions

1. **Overload `select`, don't add a new method.** (Confirmed.) `select(fn)` stays
   the callback form; `select(obj)` is the declarative form — dispatched at
   runtime on `typeof arg === 'function'`. The `$`-sigil rule keeps the object
   form's key namespace disjoint from options, so the overloaded typings stay
   tractable.
2. **No dependency on the `graphql` package.** (Confirmed.) The typed
   object-literal form (Tier 1) is the primary surface and needs no parser — it
   compiles straight to DSL-JSON. Tier 2, *if* pursued, is a small in-house
   subset parser (accepting spec-drift risk), never an external dep.

## Open questions

1. **`$` sigil vs reserved words**: `$where` can never collide with a property
   label; bare `where` could. Acceptable aesthetically? (Prisma/Mongo precedent
   says yes.)
2. **`true` vs `1` vs nested-only**: allow `name: {}` as synonym for
   `name: true`? Recommend no — keep one spelling.
3. **Wire version bump**: variables, `$if`, `$path` aliasing, and `introspect`
   are DSL-JSON additions → `"v": "1.1"`, additive only.
4. **Expression tier typing in `$where`**: ship untyped S-expressions first
   (validated at runtime against the shape), add typed builders later?
5. **Tier 2 in-house parser**: worth building at all, or is the typed
   object-literal form enough? (No `graphql` dep either way.)
6. **`selectAll` spelling**: `'*'` key, `$all: true`, or `...FieldSet.all(Person).spread()`?
