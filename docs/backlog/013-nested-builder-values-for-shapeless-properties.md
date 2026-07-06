---
summary: Let a mutation value be a typed builder/Shape instance (e.g. `Something.update(id, {relatesTo: Person.create({...})})`) so a nested new node can be written under a shapeless/polymorphic property without the value needing a decorator-declared value-shape. The value self-describes its concrete shape, which is exactly the info the engine needs to resolve the nested object's labels → predicates.
packages: [core]
---

# 013 — Nested builder/Shape values for shapeless (polymorphic) properties

> Source: raised during the Tier 4/5 error-handling discussion (report 022 / plan
> 003). Today a nested **plain object** under a property whose `@objectProperty`
> did not declare `shape:` **throws** (`MutationQuery.ts:261`) because the engine
> can't resolve the object's keys → predicates without a shape.

## The problem

To write a **new nested node**, the engine must map the object's label keys to
predicate IRIs — which requires knowing the node's concrete shape. For a
shapeless / polymorphic relation (e.g. a generic `relatesTo` typed loosely as
`owl:Thing`), that shape isn't on the property, so a plain nested object throws:

```ts
// throws — the value's shape is unknown:
Something.update(id, { relatesTo: { name: 'Bob' } })
```

Note: a **generic value-shape** (`owl:Thing` / `schema:Thing`) does *not* solve
this — a generic shape has no properties, so `{name:'Bob'}` still can't resolve.
A generic shape only helps **references** (`{relatesTo: {id}}`), which already
work with no shape at all. The nested-*create* case fundamentally needs the
*value's* concrete shape.

## Existing escape hatch (low-level, keep)

A value can already carry its own shape via a reserved `shape` key
(`MutationQuery.ts:251`):

```ts
Something.update(id, { relatesTo: { shape: Person, name: 'Bob' } })  // works today
```

It's clunky (magic reserved key, not type-safe, easy to forget) — keep it as the
low-level form, but bless a better one.

## The feature — a typed builder / Shape instance as the value

```ts
Something.update(id, { relatesTo: Person.create({ name: 'Bob' }) })
```

The value **self-describes** its concrete shape (`Person.shape`): type-safe,
discoverable via autocomplete, and it composes create-and-link into one
statement. Implementation is contained: in the value-conversion path
(`MutationQuery.convertUpdateValue`), detect a `CreateBuilder` / `UpdateBuilder`
(or a materialized `Shape` instance) value and splice its `(shape, data)` in as
the nested node description — instead of throwing on the missing value-shape.

### Sketch
- Detect via the builder's `__queryKind` discriminator (or `instanceof Shape`).
- Extract shape (`builder.shape`) + its normalized data (the builder already
  normalizes through `MutationQueryFactory.describe`).
- Feed that as the nested `NodeDescriptionValue` (equivalent to the inline
  `{shape, …}` form, but derived from the builder).

## Explicitly out of scope (decided)
- **`.as(Shape)` on the write side** — redundant; the nested builder subsumes it
  (`Person.create({…})` already *is* shape `Person`). Don't add a second way.
- **Raw-IRI-key escape hatch** (`{'http://…/name': 'Bob'}`) for truly shapeless
  writes — a niche power-user feature; lower priority. Capture separately if a
  real use case appears.

## Test sketch
- `Something.update(id, {relatesTo: Person.create({name:'Bob'})}).toJSON()` →
  nested node description carrying Person's shape + `name` field.
- Round-trips through `fromJSON` → lower to the same IR as the inline
  `{shape: Person, name:'Bob'}` form.
