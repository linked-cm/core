# Linked-query test coverage — gaps & proposed tests

Audit of the hand-written linked queries + seed data that run end-to-end against
Fuseki, vs. the features `core` actually supports.

**What runs E2E today** (query → IR → SPARQL → Fuseki → mapped result, with
result assertions):

- `src/tests/sparql-fuseki.test.ts` — 77 of the 132 fixtures in
  `query-fixtures.ts`, against the `Person/Employee/Dog/Pet` graph (`p1–p4`,
  `dog1/dog2`, `e1/e2`).
- `src/tests/property-path-fuseki.test.ts` — property paths, but via **raw
  SPARQL strings**, not the shape→IR pipeline.
- `src/tests/nested-select-pagination.test.ts` — nested `limit/offset/orderBy`
  (own seed data).

The findings below are grouped by leverage. Each proposed test lists the
**query**, the **seed data** it needs, and the **expected result**.

---

## 0. Headline findings

1. **55 fixtures are already written but never executed against seed data** —
   they only appear in golden/IR tests. Wiring these into the Fuseki suite is
   the cheapest coverage we can buy. (§1)
2. **~50 of 61 expression/filter operators have no test at all.** The fixtures
   exercise only `equals, neq, gt, lt, plus, strlen, ucase, lcase, now, size`.
   Everything else — `gte/lte`, all string fns (`concat/contains/startsWith/
   substr/replace/matches/…`), most numeric fns (`minus/times/divide/abs/round/
   ceil/floor/power`), all date-component fns (`year/month/day/…`),
   null/conditional (`isDefined/defaultTo/ifThen`), RDF introspection
   (`str/iri/lang/datatype/isLiteral/…`), hashes (`md5/sha256/sha512`), and the
   `sum/avg/min/max` aggregates — is untested. (§2, §3)
3. **Datatype coverage is integer/boolean/dateTime/string only.** No
   `decimal/double/float/long`, no `xsd:date` (only `dateTime`), and
   language-tagged strings silently drop their tag. (§4)
4. **Property paths are never tested through the DSL** — only as raw SPARQL. (§5)
5. **Several builder features are untested E2E**: multi-key `orderBy`,
   mixed ASC/DESC, top-level `offset`, `toJSON/fromJSON` round-trip execution,
   `.for(getQueryContext(...))` resolution, FieldSet composition. (§6)

---

## 1. Wire up already-written-but-unexecuted fixtures (highest leverage)

These 55 fixtures exist in `query-fixtures.ts` and are golden-tested but have no
result assertion against the Fuseki graph. Add an execution + assertion for each.
Grouped by feature:

### 1a. MINUS / exclusion — none executed
| Fixture | Query | Expected (against p1–p4 + e1/e2) |
|---|---|---|
| `minusShape` | `Person.select(p=>p.name).minus(Employee)` | the 4 Persons, **not** e1/e2 |
| `minusCondition` | `…minus(p=>p.hobby.equals('Chess'))` | everyone whose hobby ≠ Chess |
| `minusChained` | `…minus(Employee).minus(p=>p.hobby.equals('Chess'))` | both exclusions applied |
| `minusMultiProperty` | `…minus(p=>[p.hobby,p.nickNames])` | excludes rows where **all** listed props exist (p1 has both → excluded) |
| `minusNestedPath` | `…minus(p=>[p.bestFriend.name])` | excludes rows with a named bestFriend (p2 → excluded) |
| `minusMixed` | `…minus(p=>[p.hobby,p.bestFriend.name])` | flat + nested exclusion |
| `minusSingleProperty` | `…minus(p=>p.hobby)` | excludes anyone with a hobby (p1,p2) → returns p3,p4 |

### 1b. Bulk / conditional mutations — none executed
| Fixture | Query | Expected |
|---|---|---|
| `deleteAll` / `deleteAllBuilder` | `Person.deleteAll()` | all Person triples gone (run on a throwaway clone of the graph) |
| `deleteWhere` / `deleteWhereBuilder` | `Person.deleteWhere(p=>p.hobby.equals('Chess'))` | only Chess-players deleted |
| `updateForAll` | `Person.update({hobby:'Chess'}).forAll()` | every Person.hobby = "Chess" |
| `updateWhere` | `Person.update({hobby:'Archived'}).where(p=>p.hobby.equals('Chess'))` | only matching rows updated |

> These mutate the shared graph — run them in an isolated dataset or restore in
> `finally` like the existing UPDATE tests.

### 1c. Expression-based filters (`whereExpr*`) — none executed
| Fixture | Query | Expected |
|---|---|---|
| `whereExprStrlen` | `…where(p=>p.name.strlen().gt(5))` | names longer than 5 chars ("Semmy"=5 → excluded; "Quinn"=5 → excluded) → none of the current names; **add a longer name to seed** |
| `whereExprArithmetic` | `…where(p=>p.name.strlen().plus(10).lt(100))` | all rows |
| `whereExprAndChain` | `…where(p=>p.name.strlen().gt(5).and(...lt(20)))` | combined bounds |
| `whereExprMixed` | `…where(p=>p.name.equals('Bob').and(p.name.strlen().gt(3)))` | Evaluation `.and()` ExpressionNode |
| `whereExprNestedPath` | `…where(p=>p.bestFriend.name.strlen().gt(3))` | rows whose bestFriend's name >3 |
| `whereExprNot` | `…where(p=>Expr.not(p.name.equals('Alice').and(p.hobby.equals('Chess'))))` | De Morgan negation |
| `whereExprWithProjection` | filter + computed projection in one query | both applied |
| `whereExprUpdateBuilder` | `Person.update({hobby:'Archived'}).where(p=>p.name.strlen().gt(3))` | expr filter on UPDATE |
| `whereExprDeleteBuilder` | `DeleteBuilder.from(Person).where(p=>p.name.strlen().gt(3))` | expr filter on DELETE |

### 1d. Negation / quantifier filters — none executed
`whereNone`, `whereSomeNot`, `whereEqualsNot`, `whereNeq`, `whereNoneAndEquals`.
Example: `whereNone` = `Person.select(p=>p.name).where(p=>p.friends.none(f=>f.hobby.equals('Chess')))`
→ everyone with no Chess-playing friend.

### 1e. Computed expression projections (`expr*`) — none executed
| Fixture | Query | Expected |
|---|---|---|
| `exprStrlen` | `Person.select(p=>p.name.strlen())` | numeric length per person (Semmy→5) |
| `exprCustomKey` | `Person.select(p=>({nameLen:p.name.strlen()}))` | `{nameLen:5}` etc. |
| `exprNestedPath` | `Person.select(p=>p.bestFriend.name.ucase())` | uppercased bestFriend name |
| `exprMultiple` | `Person.select(p=>[p.name,p.name.strlen()])` | both raw + computed |

### 1f. Expression-based updates (`updateExpr*`) — none executed
| Fixture | Query | Expected |
|---|---|---|
| `updateExprCallback` | `Dog.update(d=>({guardDogLevel:d.guardDogLevel.plus(1)})).for(d1)` | dog1 level 2→3 (**seed needs a `d1` Dog with guardDogLevel**) |
| `updateExprNow` | `Person.update({birthDate:Expr.now()}).for(p1)` | birthDate ≈ now |
| `updateExprTraversal` | `Person.update(p=>({hobby:p.bestFriend.name.ucase()})).for(p1)` | hobby = uppercased traversed value |
| `updateExprSharedTraversal` | two fields off `p.bestFriend` | both written from one traversal |

### 1g. Deep nesting / sub-select shapes — none executed
`tripleNestedSubSelect`, `doubleNestedSingularPlural`, `doubleNestedPluralSingular`,
`employeeSubSelect`, `mixedPathAndSubSelect`, `multipleSubSelectsInArray`,
`pluralFilteredNestedSubSelect`, `subSelectArrayOfPaths`,
`subSelectSingularArrayPaths`, `subSelectWithCount`, `subSelectWithOne`,
`subSelectAllPlural`, `subSelectAllSingular`, `selectBestFriendOnly`.
These validate nested-object reconstruction shapes the golden tests can't catch
(actual array/object grouping in results).

### 1h. Preload variants — partially executed
`preloadBestFriendWithFieldSet`, `queryBuilderPreload` (only `preloadBestFriend`
runs today).

---

## 2. Operators with no fixture at all — add fixtures + tests

The seed graph needs a few numeric/date/string-rich fields first (see §4 seed
plan). Then add filter + projection tests for each operator.

### 2a. Comparison
- `gte` / `lte` (and long forms `greaterThanOrEqual`/`lessThanOrEqual`):
  `Person.select(p=>p.name).where(p=>p.age.gte(30))`.

### 2b. String functions (all untested)
`concat`, `contains`, `startsWith`, `endsWith`, `substr`, `before`, `after`,
`replace`, `encodeForUri`, `matches`(regex). Examples:
- `contains`: `…where(p=>p.name.contains('in'))` → "Jinx","Quinn".
- `startsWith`: `…where(p=>p.name.startsWith('S'))` → "Semmy".
- `concat` projection: `Person.select(p=>({label:p.name.concat(' (',p.hobby,')')}))`.
- `replace`: `Person.select(p=>p.name.replace('a','@','i'))`.
- `matches`: `…where(p=>p.name.matches('^[JQ]','i'))` → "Jinx","Quinn".

### 2c. Numeric functions (only `plus` tested)
`minus`, `times`, `divide`, `abs`, `round`, `ceil`, `floor`, `power`. Example
(needs a numeric `age`/`score` field): `Person.select(p=>({half:p.age.divide(2)}))`,
`…round()`, `…abs()` on a negative value.

### 2d. Date-component functions (none tested)
`year`, `month`, `day`, `hours`, `minutes`, `seconds`, `timezone`/`tz` on
`birthDate`. Example: `Person.select(p=>({y:p.birthDate.year()})).for(p1)` → 1990;
filter `…where(p=>p.birthDate.year().lt(2000))`.

### 2e. Null / conditional (none tested)
- `isDefined` / `isNotDefined`: `…where(p=>p.hobby.isNotDefined())` → p3,p4.
- `defaultTo` (coalesce): `Person.select(p=>({h:p.hobby.defaultTo('none')}))`
  → p3/p4 get "none".
- `Expr.ifThen(cond,a,b)`: projected conditional value.

### 2f. RDF introspection (none tested)
`str`, `iri`, `isIri`, `isLiteral`, `isBlank`, `isNumeric`, `lang`, `datatype`.
Example: `Person.select(p=>({t:p.name.datatype()}))`; `lang()` needs a
language-tagged literal (see §4).

### 2g. Hash functions (none tested)
`md5`, `sha256`, `sha512`: `Person.select(p=>({h:p.name.md5()})).for(p1)` →
known MD5 of "Semmy".

### 2h. Aggregates beyond count (none tested)
`sum`, `avg`, `min`, `max` exist in the IR but only `count` (`.size()`) is
tested. Need numeric multi-valued data (e.g. friends' ages) and tests asserting
the aggregate value per group. **Confirm whether these are reachable from the
DSL** — if not, that itself is a gap worth a note/test.

---

## 3. Boolean projection — known limitation to pin down
`customResultEqualsBoolean` (`{isBestFriend: p.bestFriend.equals(p3)}`) is run
but only asserts the result is an array — the boolean field isn't projected
(noted as a known limitation in the test). Add a test that asserts the intended
`true/false` per row once supported, or document the gap explicitly.

---

## 4. Datatype & literal coverage — extend the seed graph

Result coercion handles `boolean`, the numeric set (`integer/long/decimal/
float/double`), `date`/`dateTime`, and strings — but the seed only contains
`integer` (guardDogLevel), `boolean`, `dateTime`, and plain strings.

**Proposed seed/shape additions** (add properties to `Person` in
`query-fixtures.ts` + triples in `TEST_DATA`):

| Property | Datatype | Why |
|---|---|---|
| `age` | `xsd:integer` | numeric filters/arithmetic, min/max/avg/sum |
| `score` | `xsd:decimal` | decimal coercion (→ JS number) |
| `rating` | `xsd:double` / `xsd:float` | float/double coercion |
| `views` | `xsd:long` | long coercion |
| `joinedOn` | `xsd:date` (not dateTime) | date vs dateTime coercion path |
| `bio` | `rdf:langString` (`"Hi"@en`) | **language tag behavior** — currently dropped; assert and decide intended behavior |

Tests to add:
- Each new datatype: select → assert JS type & value (e.g. `score` → `number`,
  `joinedOn` → `Date`).
- **Negative number** round-trip (`abs`, ordering).
- **Multi-valued numeric/boolean** literal (e.g. several `age` values) →
  array collection + dedup + ordering (today only multi-valued **strings**
  (`nickNames`) and URIs are exercised).
- **Language-tagged string**: assert what `lang()`/value mapping returns; if the
  tag is intentionally dropped, lock that in; if not, this is a bug-surfacing test.
- **Serialization round-trip**: create/update with a `Date`, decimal, boolean →
  read back → assert datatype-tagged literal stored and re-parsed.

---

## 5. Property paths through the DSL (not just raw SPARQL)

`property-path-fuseki.test.ts` proves `pathExprToSparql` works, but never runs a
**shape decorator → IR → SPARQL** path query against data. Add fixtures whose
shapes use `seq`/`inv`/`alt`/`oneOrMore`/`zeroOrMore`/`zeroOrOne` paths and
assert mapped results against a seeded graph.

**Seed**: a small chain reusing the `friends`/`bestFriend` edges, plus a couple
of inverse/alternative edges. Examples:
- Sequence object property (`member/role`) — already modeled in
  `property-path-integration.test.ts` but golden-only; run it against data.
- Inverse: a `parent`-of chain → assert `^parent/name`.
- Transitive: `Person` with a `manages+` path → assert transitive reports
  (Alice→Bob→Carol) end-to-end through a shape, not a raw string.

---

## 6. Query-builder features untested E2E

| Feature | Proposed test | Expected |
|---|---|---|
| Multi-key `orderBy` | `Person.select(p=>[p.name,p.hobby]).orderBy(p=>[p.hobby,p.name])` | stable multi-key order |
| Mixed ASC/DESC | order one key ASC, another DESC | per-key direction honored |
| `orderBy` on nested path | `orderBy(p=>p.bestFriend.name)` | sorted by traversed value |
| Top-level `offset` | `Person.select(p=>p.name).orderBy(p=>p.name).offset(1).limit(2)` | window p2/p3 (only nested offset is tested today) |
| `toJSON`/`fromJSON` round-trip | serialize a complex query, rebuild, execute | identical results to the original |
| `.for(getQueryContext(...))` | resolve a context entity as subject and execute | context-bound row |
| FieldSet composition | `FieldSet.merge/add/remove/pick` → build → execute | projected fields match composed set |
| `.as(Shape)` deeper | cast then select subclass-only props through a traversal | subclass props populated |
| `distinct` | a query that would duplicate rows | deduped (confirm auto-DISTINCT behavior) |

---

## 7. Suggested structure for the new tests

- **Reuse the existing harness** in `sparql-fuseki.test.ts`
  (`runSelectMapped`/`runSelect`) and the skip-if-no-Fuseki guard.
- **Extend `query-fixtures.ts`** with the new shape properties (§4) and any new
  fixtures (§2/§5), so golden + E2E tests share one source of truth.
- **Extend `TEST_DATA`** with the numeric/date/langString/multi-valued triples,
  plus a couple of extra friend/parent/manages edges for paths and aggregates.
- For mutating tests (§1b, §1f), isolate in a separate dataset or restore in
  `finally`, matching the current UPDATE/DELETE pattern.
</content>
</invoke>
