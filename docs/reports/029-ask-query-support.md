---
summary: Ask queries as a first-class kind — `AskBuilder`, `IRAskQuery`, an `op:'ask'` DSL-JSON envelope and `ASK WHERE { … }` — with `IDataset.askQuery` required and no path anywhere that rewrites an ask as a select. Adds shapeless existence (`Shape.exists(uri)` → `ASK { <uri> ?p ?o }`) and the router fan-out it requires. Ships alongside the `targetClass` fix (report section below), which changed every golden's `rdf:type`.
source_plan: docs/plans/002-ask-query-support.md (converted; plan removed)
packages: [core]
---

# 029 — Ask queries

Status: **done**. Suite **69 suites / 1708 passed / 120 skipped**, typecheck green (baseline before
this work: 1654 passed). `minor`, with two **breaking** changes: `IDataset.askQuery` is required and
takes an `AskQuery`, and a shape must declare a `targetClass`.

Stacked on PR #206 (`feat/shape-exists`, report 028) — `.exists()` is the consumer. Merges after it.

## What shipped

`.exists()` is a **shortcut for an ask query**, not a special case of select. Nothing in the stack
models it as a select with fields switched off:

| Layer | Type | What it cannot express |
|---|---|---|
| DSL | `AskBuilder` | no `select`, `orderBy`, `limit`, `offset`, `preload` |
| Wire | `{op: 'ask', …}` | no `fields`, `sortBy`, `limit`, `offset`, `one` |
| IR | `IRAskQuery` | no `projection`, `orderBy`, `limit`, `offset` |
| SPARQL | `SparqlAskPlan` | pattern only |

```ts
await Person.exists({id});                                           // ASK { ?a0 a <PersonClass> . FILTER(?a0 = <id>) }
await Person.select().where((p) => p.name.equals('Semmy')).exists();  // ASK with the filter
await Shape.exists(uri);                                             // ASK { <uri> ?p ?o }
```

`SelectBuilder.exists()` reduces itself to an `AskBuilder` (`_toAsk()`), keeping shape, subject(s),
filters and `minus`. Report 028 cloned a select and cleared eight fields; the normalisation is now a
property of the type it lands in, so it cannot be forgotten or half-applied.

The pattern is still built by `selectToAlgebra` — one implementation of shape scans, traversals,
filters and `MINUS`. `askToAlgebra` keeps the pattern and discards the plan's projection.
Duplicating 2,000 lines of pattern building to avoid that reuse would be the worse trade.

## Decisions

### No fallback anywhere — the big one

Earlier iterations had an optional `askQuery` with a shared `askViaSelect` degradation. Both are
gone. A store with no boolean primitive decides for itself how to answer; that decision belongs to
the store, and defaulting it in this package hid it.

Removing the fallback also removed a whole class of guard. While two paths existed they had to be
kept in agreement about pagination — `askToAlgebra` rejected `OFFSET` and `LIMIT < 1`, and the same
guard had to run in front of the SELECT path, which *would* have honoured them and answered a
different question. With one path there is nothing to keep in agreement, and `IRAskQuery` cannot
carry pagination at all. Both guards and their tests were deleted rather than maintained. That is
the clearest evidence the fallback was load-bearing complexity rather than a safety net.

### A method, not a boolean-returning `selectQuery`

The query genuinely *is* an ordinary select query — same pattern, same shape scan; only the answer
differs. But that is an argument about the *input*, not the return type. Folding it into
`selectQuery` widens its return to `SelectResult | boolean`, so every caller narrows, and — the real
cost — a store that ignores the "boolean please" signal returns **rows where a boolean was
expected**, silently, at runtime. With a separate method, not implementing it is a compile error.

### `op: 'ask'`, not a flag on the select envelope

An `exists: true` flag was considered and rejected. Two reasons, the second decisive:

- Ask questions extend by *pattern*, so a flag-per-question does not scale. The pattern **is** the
  question.
- `QueryBuilderJSON.shape` is a required `string`. A flag literally **cannot express a shapeless
  ask** without also loosening the select envelope.

```json
{"v": "1.1", "op": "ask", "shape": "…/Person", "subject": "…/p1"}
{"v": "1.1", "op": "ask", "subject": "https://example.org/thing"}
```

Omitting `shape` *is* the shapeless discriminator, mirroring `IRAskQuery.root?`. `fromJSON` already
switched on `op` and still throws `Unknown query op` on anything unrecognised, so an older peer
fails loud rather than reinterpreting the envelope as a select. Deploy receivers first.

There is deliberately **no `question` discriminator**. Every ask question I could construct — does
this node exist, as this shape, matching this filter, related by this path — is the same envelope
with a different pattern. The one genuinely different case is SHACL conformance, which is not
pattern-shaped and should get its own `op`.

### Shapeless existence, and the routing problem it creates

`Shape.exists(uri)` on the **base class** asks whether a node exists at all. `IRAskQuery.root` is
optional, so this is the same type with the shape scan absent, not a separate path. `Shape` is free
to mean "anything" because the shapes themselves are described by `NodeShape` and `PropertyShape`.

A shapeless ask has **no routing key**. Asking only the default dataset would answer `false` for a
node living in a pinned one — a wrong answer, quietly, which is the failure class this work exists
to remove. So `LinkedStorage.askQuery` fans out across `getDatasets()` and ORs, short-circuiting on
the first `true` and propagating any failure (an unreachable store makes the answer unknown, and
unknown is not `false`). It is cheap *because* the answers are booleans; the same sweep for rows
would not be. Any other router implementing `IDataset` inherits the obligation.

A shapeless ask cannot carry `where` or `minusEntries` — both name properties, and a property is
only resolvable through a shape. An envelope that carries them without a `shape` is rejected as
malformed rather than guessed at.

### Contract, enforced once

`resolveExistence` is the single entry point (`AskBuilder.exec` and `LinkedStorage.askQuery` both
go through it). It rejects a non-boolean answer rather than coercing it — a truthy value would read
as "exists" — and lets errors propagate, because "could not ask" is never `false`.

## Shipped alongside: `rdf:type` resolves to `targetClass`, or throws

`resolveShapeScanIri` used to fall back to the shape's own IRI when no `targetClass` resolved, and
to *discard* a `targetClass` whose IRI was still temporary (`linked://tmp/`). `rdf:type` names the
class a node **is**; the shape IRI identifies the SHACL description **of** that class. The fallback
conflated them, and did so invisibly — `selectToAlgebra` and `createToAlgebra` resolve through the
same function, so data round-tripped and nothing surfaced the mistake.

Now: a temporary `targetClass` is honoured like any other (it is a real node whose IRI is not final),
and a shape with none anywhere in its chain throws. No explicit chain walk was needed — `targetClass`
is read off the shape class, so JavaScript static inheritance already does it.

Every fixture declared a temporary `targetClass`, so **every golden was asserting the fallback**.
Type triples now carry the class node while property predicates still derive from the shape IRI, and
Fuseki seed data is typed to match.

**Open, deliberately out of scope:** `resolvePropertyPredicate` has the identical fallback for
`sh:path` — a temporary path IRI is discarded in favour of the property shape's own IRI. Same
function, same reasoning, not asked for here.

## Tests

Suite 1654 → 1708. Deleted along with the designs they described: the ASK ≡ SELECT equivalence
block, and the `OFFSET` / `LIMIT 0` modifier guards.

- `ask-wire.test.ts` (new, 14) — envelope shape for every pattern form; round trip compared down to
  the emitted SPARQL; `fromJSON` routes `op:'ask'` to an `AskBuilder` and still fails loud on an
  unknown op; a shapeless envelope carrying `where` is rejected; `Shape.exists` reaches a shapeless
  ask where `Person.exists` reaches a shaped one.
- `sparql-ask-golden.test.ts` — literal `ASK` output, plus shapeless goldens asserting no `rdf:type`
  triple, no shape IRI, `root` undefined, and that a subjectless shapeless ask is rejected.
- `query-builder.test.ts` — the store's boolean is returned without `selectQuery` ever being
  reached; non-boolean answers reject; failures and `UnresolvedContextError` reject; pagination is
  unrepresentable rather than guarded.
- `store-routing.test.ts` — shaped asks route to the pinned dataset and never touch `selectQuery`;
  shapeless asks fan out, OR, short-circuit, and propagate failures.
- `sparql-negative.test.ts` — the `targetClass` throw, its message, and temporary-IRI-is-honoured.
- `sparql-fuseki-coverage.test.ts` — against live Fuseki: the wire carries `ASK`; eight patterns
  answer correctly; `Shape.exists` returns `true` for a Dog IRI where `Person.exists` returns
  `false`, with no `rdf:type` in the emitted query.

**Environment note.** Docker is unavailable in this container, so the suite's Fuseki auto-start
could not run. Fuseki 5.5.0 was run directly on the JVM
(`java -jar jena-fuseki-server-5.5.0.jar --mem --port=3939 /nashville-test`), which serves the same
admin API the test helper uses. All `sparql-fuseki*` suites executed and passed against it; nothing
was skipped that CI would run.

## Follow-ups

- `resolvePropertyPredicate`'s `sh:path` fallback (above) — same bug, unfixed.
- Backlog **036** — rewritten again: only the gateway/server side of `op:'ask'` remains.
- Backlog **004** (`CONSTRUCT`) — the seam this rehearsed. `AskBuilder`/`IRAskQuery` is the pattern
  to copy; the result mapping is where the two diverge.
