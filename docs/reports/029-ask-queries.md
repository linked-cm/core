---
summary: Ask queries as a first-class kind — `AskBuilder`, `IRAskQuery`, an `op:'ask'` DSL-JSON envelope and `ASK WHERE { … }` — with `IDataset.askQuery` required and no path anywhere that rewrites an ask as a select. Includes shapeless existence (`Shape.exists(uri)`) with router fan-out, the `targetClass` fix for `rdf:type`, and removal of the `linked://tmp/` resolver skip that was hiding a declared `sh:path`.
source_plan: docs/plans/002-ask-query-support.md (converted; plan removed)
packages: [core]
---

# 029 — Ask queries

Status: **done**. Suite **69 suites / 1716 passed / 120 skipped**, typecheck green (baseline before
this work: 1654). One `minor` changeset, carrying two breaking changes: `IDataset.askQuery` is
required, and a shape must declare a `targetClass`.

Stacked on PR #206 (`feat/shape-exists`, report 028) — `.exists()` is the consumer. Merges after it.

Two defects found along the way were unrelated to this change and went to their own branches off
`dev`; see **Spin-offs** at the end.

## 1. Ask queries

`.exists()` is a **shortcut for an ask query**, not a special case of select. Nothing in the stack
models it as a select with fields switched off:

| Layer | Type | Cannot express |
|---|---|---|
| DSL | `AskBuilder` | `select`, `orderBy`, `limit`, `offset`, `preload` |
| Wire | `{op: 'ask', …}` | `fields`, `sortBy`, `limit`, `offset`, `one` |
| IR | `IRAskQuery` | `projection`, `orderBy`, `limit`, `offset` |
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
filters and `MINUS`. `askToAlgebra` keeps it and discards the projection. Duplicating 2,000 lines of
pattern building to avoid that reuse would be the worse trade.

### No fallback anywhere — the decisive decision

Earlier iterations had an optional `askQuery` with a shared `askViaSelect` degradation. Both are
gone. A store with no boolean primitive decides for itself how to answer; that decision belongs to
the store, and defaulting it here hid it.

Removing the fallback also deleted a class of guard. While two paths existed they had to agree about
pagination — `askToAlgebra` rejected `OFFSET` and `LIMIT < 1`, and the same guard had to run in
front of the SELECT path, which *would* have honoured them and answered a different question. With
one path there is nothing to keep in agreement, and `IRAskQuery` cannot carry pagination at all.
Both guards and their tests were deleted rather than maintained — the clearest evidence the fallback
was load-bearing complexity rather than a safety net.

### A method, not a boolean-returning `selectQuery`

The query genuinely *is* an ordinary select query — same pattern, same shape scan; only the answer
differs. But that is an argument about the *input*, not the return type. Folding it into
`selectQuery` widens its return to `SelectResult | boolean`, so every caller narrows, and — the real
cost — a store that ignores the "boolean please" signal returns **rows where a boolean was
expected**, silently, at runtime. With a separate method, not implementing it is a compile error.

### `op: 'ask'`, not a flag on the select envelope

An `exists: true` flag was considered and rejected. Ask questions extend by *pattern*, so a
flag-per-question does not scale — the pattern **is** the question. And decisively:
`QueryBuilderJSON.shape` is a required `string`, so a flag **cannot express a shapeless ask** without
also loosening the select envelope.

Omitting `shape` is the shapeless discriminator, mirroring `IRAskQuery.root?`. `fromJSON` already
switched on `op` and still throws `Unknown query op` on anything unrecognised, so an older peer fails
loud. There is deliberately no `question` discriminator: every ask question constructible today is
the same envelope with a different pattern. The one genuinely different case is SHACL conformance,
which is not pattern-shaped and should get its own `op`.

### Shapeless existence, and the routing problem it creates

`Shape.exists(uri)` on the **base class** asks whether a node exists at all. `IRAskQuery.root` is
optional, so this is the same type with the shape scan absent, not a separate path. `Shape` is free
to mean "anything" because the shapes themselves are described by `NodeShape` and `PropertyShape`.

A shapeless ask has **no routing key**. Asking only the default dataset would answer `false` for a
node living in a pinned one — a wrong answer, quietly, which is the failure class this work exists to
remove. `LinkedStorage.askQuery` therefore fans out across `getDatasets()` and ORs, short-circuiting
on the first `true` and propagating any failure (an unreachable store makes the answer unknown, and
unknown is not `false`). Cheap *because* the answers are booleans; the same sweep for rows would not
be. Any other router implementing `IDataset` inherits the obligation.

A shapeless ask cannot carry `where` or `minusEntries` — both name properties, and a property is only
resolvable through a shape. An envelope carrying them without a `shape` is rejected as malformed.

### Contract, enforced once

`resolveExistence` is the single entry point (`AskBuilder.exec` and `LinkedStorage.askQuery` both go
through it). It rejects a non-boolean answer rather than coercing it, and lets errors propagate,
because "could not ask" is never `false`.

## 2. `rdf:type` resolves to `targetClass`, or throws

`resolveShapeScanIri` fell back to the shape's own IRI when no `targetClass` resolved, and
*discarded* a `targetClass` whose IRI was still temporary. `rdf:type` names the class a node **is**;
the shape IRI identifies the SHACL description **of** that class. The fallback conflated them, and
invisibly — `selectToAlgebra` and `createToAlgebra` resolve through the same function, so data
round-tripped and nothing surfaced the mistake.

Now a shape with no `targetClass` anywhere in its chain throws. No explicit chain walk was needed:
`targetClass` is read off the shape class, so JavaScript static inheritance already does it.

Measured across every shape in the repo, only two categories changed. Shapes with a real
`targetClass` (`List` → `rdf:List`, `NodeShape` → `shacl:NodeShape`, `PathNode`, `PropertyShape`) are
**byte-identical** before and after. The fixtures moved, and shapes with no `targetClass` now throw.

## 3. The `linked://tmp/` skip was a test-fixture workaround

`shouldResolveShapeOrPropertyId` skipped any shape or property IRI beginning `linked://tmp/`. **No
production code ever minted one** — `generateEntityUri` uses `dataRoot ?? DATA_ROOT ??
'http://example.org/data'`. The bases were declared in `query-fixtures.ts` and nowhere else, and
`mutation-uri-fidelity.test.ts` said so outright: *"the shared query-fixtures shape uses
`linked://tmp/` which is intentionally skipped by the resolver (existing golden-SELECT tests rely on
raw shape ids)"* — a parallel fixture shape existed to work around it.

The fixtures now declare ordinary IRIs and the skip is deleted. Consequences:

- **A declared `sh:path` is always the predicate.** The property shape IRI is a "shadow" URI which
  that suite already says must never leak into emitted SPARQL. Read and write sides both go through
  `resolvePropertyPredicateTerm`.
- **A real bug fell out.** Two mutation sites built traversal predicates as `iriTerm(trav.property)`,
  bypassing the resolver. Invisible while its fallback returned that same id; with the skip gone, an
  expression update referencing `p.bestFriend.name` emitted the shadow IRI as its predicate — and
  since accessor and path need not be spelled alike, that predicate can match nothing, so the update
  silently deleted the old value and inserted none.
- Subject IRIs keep `linked://tmp/entities/` — plain data, never resolved through the skip.

**Correction on the record:** an earlier note in this work described the fixture predicate churn as
user-facing corrections (`pets`/`firstPet`, `Person.name`/`Employee.name`). Those were only ever
wrong *in the fixtures* — for any real shape the read side was unchanged, since only `linked://tmp/`
paths hit the fallback. The mutation-traversal defect above is the one user-facing fix here.

## Review

`/code-review` at high effort over the branch. Findings, all fixed:

- **`_toAsk()` resolved context refs locally.** It narrowed the subject with `'id' in subject`, but
  `PendingQueryContext` has an `id` *getter*, so the check passed and the context resolved against
  *this* process's map. The ask then travelled as a concrete IRI where the equivalent select travels
  as `{"@ctx": name}` for the receiver to resolve against its own (server-side auth, say).
- **`toRawInput()` dropped `nullSubject`.** So "`.for(null)` answers false without querying" held
  only in `exec()`. A store handed the builder directly lowered `ASK { ?a0 rdf:type <Person> }` and
  got `true`. Now carried, and lowering refuses it loudly.
- **A changeset contradiction** in `.changeset/shape-exists.md`, corrected.

One finding was pre-existing and became a spin-off (below).

## Tests

1654 → 1716. Deleted along with the designs they described: the ASK ≡ SELECT equivalence block and
the `OFFSET` / `LIMIT 0` modifier guards.

- `ask-wire.test.ts` (new, 18) — envelope shape per pattern form; round trip compared down to the
  emitted SPARQL; `fromJSON` routing and loud failure on an unknown op; a shapeless envelope carrying
  `where` rejected; context refs surviving serialization and still resolving locally; null subjects
  carried and refused at lowering.
- `sparql-ask-golden.test.ts` (new) — literal `ASK` output plus shapeless goldens: no `rdf:type`, no
  shape IRI, `root` undefined, and a subjectless shapeless ask rejected.
- `query-builder.test.ts` — the store's boolean returned without `selectQuery` ever being reached;
  non-boolean answers rejected; failures and `UnresolvedContextError` rejected; pagination
  unrepresentable rather than guarded.
- `store-routing.test.ts` — shaped asks route to the pinned dataset and never touch `selectQuery`;
  shapeless asks fan out, OR, short-circuit and propagate failures.
- `sparql-negative.test.ts` — the `targetClass` throw, its message, and temporary-IRI-is-honoured.
- `mutation-uri-fidelity.test.ts` — three expression-traversal cases, the gap that let the shadow-URI
  leak survive. `MfPerson` gained an object property whose accessor and path are spelled
  **differently** (`bestFriend` → `knows`); no shared fixture does that, which is exactly why the
  wrong predicate and the right one were the same string.
- `sparql-fuseki-coverage.test.ts` — against live Fuseki: the wire carries `ASK`; eight patterns
  answer correctly; `Shape.exists` returns `true` for a Dog IRI where `Person.exists` returns
  `false`, with no `rdf:type` in the emitted query.

**Environment note.** Docker is unavailable in this container, so the suite's Fuseki auto-start could
not run. Fuseki 5.5.0 was run directly on the JVM
(`java -jar jena-fuseki-server-5.5.0.jar --mem --port=3939 /nashville-test`), which serves the same
admin API the helper uses. All `sparql-fuseki*` suites executed and passed; nothing was skipped that
CI would run.

## Spin-offs (separate branches off `dev`)

- **`claude/fix-update-where-traversal-scope`** — `update(expr).where(…)` with a traversal emitted
  the leaf property `OPTIONAL` *beside and before* the edge, so its subject variable was introduced
  by an `OPTIONAL` sharing no variable with anything to its left: a cartesian product over every node
  in the store carrying that predicate, every row of which reached the `INSERT`. Measured on the seed
  dataset, `hobby` (`maxCount 1`) came back as `["JINX", "MAXIMILIAN", "MOA", "QUINN", "SEMMY"]`.
  Pre-existing on `dev`; `.for(id)` was already correct.
- **`claude/fuseki-per-worker-dataset`** — the four Fuseki suites each seed and clear the whole
  dataset and all shared one, so they clobbered each other in parallel (4 suites / 71 tests failing
  on `dev` without `--runInBand`). The dataset name now carries `JEST_WORKER_ID`. Measured on 4
  cores: 15s → 9s, 1632 passed both ways. Closes backlog 037.

## Follow-ups

- Backlog **036** (rewritten) — only the gateway/server half of `op: 'ask'` remains.
- Backlog **004** (`CONSTRUCT`) — the seam this rehearsed. `AskBuilder`/`IRAskQuery` is the pattern
  to copy; result mapping is where the two diverge.
