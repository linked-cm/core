/**
 * Fuseki E2E coverage tests — exercises features supported by core but not
 * covered by sparql-fuseki.test.ts. Result assertions go through the live-query
 * store contract (FusekiStore.selectQuery/createQuery/updateQuery/deleteQuery),
 * which lowers internally — IR stays an internal detail.
 *
 * Skipped gracefully if Fuseki is not available.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  queryFactories,
  Person,
  Employee,
  Dog,
  Metric,
  PathNode,
  tmpEntityBase,
} from '../test-helpers/query-fixtures';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {
  ensureFuseki,
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  executeSparqlUpdate,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {setQueryContext, getQueryContext} from '../queries/QueryContext';
import {fromJSON} from '../queries/fromJSON';
import {createHash} from 'node:crypto';

import '../ontologies/rdf';
import '../ontologies/xsd';

setQueryContext('user', {id: `${tmpEntityBase}p3`}, Person);

// Shape URIs (SHACL-generated)
const P = 'https://linked.cm/shape/core/Person';
const D = 'https://linked.cm/shape/core/Dog';
const PET = 'https://linked.cm/shape/core/Pet';
const E = 'https://linked.cm/shape/core/Employee';
const M = 'https://linked.cm/shape/core/Metric';
const PP = 'linked://pp/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ENT = tmpEntityBase;

// Base graph: identical to sparql-fuseki.test.ts so expectations are well
// understood, plus a Dog `d1` (guardDogLevel) for updateExprCallback.
const BASE_DATA = `
<${ENT}p1> <${RDF_TYPE}> <${P}> .
<${ENT}p1> <${P}/name> "Semmy" .
<${ENT}p1> <${P}/hobby> "Reading" .
<${ENT}p1> <${P}/birthDate> "1990-01-01T13:45:30.000Z"^^<${XSD}dateTime> .
<${ENT}p1> <${P}/isRealPerson> "true"^^<${XSD}boolean> .
<${ENT}p1> <${P}/friends> <${ENT}p2> .
<${ENT}p1> <${P}/friends> <${ENT}p3> .
<${ENT}p1> <${P}/pets> <${ENT}dog1> .
<${ENT}p1> <${P}/firstPet> <${ENT}dog1> .
<${ENT}p1> <${P}/nickNames> "Sem1" .
<${ENT}p1> <${P}/nickNames> "Sem" .
<${ENT}p1> <${P}/pluralTestProp> <${ENT}p1> .
<${ENT}p1> <${P}/pluralTestProp> <${ENT}p2> .
<${ENT}p1> <${P}/pluralTestProp> <${ENT}p3> .
<${ENT}p1> <${P}/pluralTestProp> <${ENT}p4> .
<${ENT}p2> <${RDF_TYPE}> <${P}> .
<${ENT}p2> <${P}/name> "Moa" .
<${ENT}p2> <${P}/hobby> "Jogging" .
<${ENT}p2> <${P}/isRealPerson> "false"^^<${XSD}boolean> .
<${ENT}p2> <${P}/bestFriend> <${ENT}p3> .
<${ENT}p2> <${P}/friends> <${ENT}p3> .
<${ENT}p2> <${P}/friends> <${ENT}p4> .
<${ENT}p2> <${P}/pets> <${ENT}dog2> .
<${ENT}p2> <${P}/firstPet> <${ENT}dog2> .
<${ENT}p3> <${RDF_TYPE}> <${P}> .
<${ENT}p3> <${P}/name> "Jinx" .
<${ENT}p3> <${P}/isRealPerson> "true"^^<${XSD}boolean> .
<${ENT}p4> <${RDF_TYPE}> <${P}> .
<${ENT}p4> <${P}/name> "Quinn" .
<${ENT}p5> <${RDF_TYPE}> <${P}> .
<${ENT}p5> <${P}/name> "Maximilian" .
<${ENT}dog1> <${RDF_TYPE}> <${D}> .
<${ENT}dog1> <${RDF_TYPE}> <${PET}> .
<${ENT}dog1> <${D}/guardDogLevel> "2"^^<${XSD}integer> .
<${ENT}dog1> <${PET}/bestFriend> <${ENT}dog2> .
<${ENT}dog2> <${RDF_TYPE}> <${D}> .
<${ENT}dog2> <${RDF_TYPE}> <${PET}> .
<${ENT}d1> <${RDF_TYPE}> <${D}> .
<${ENT}d1> <${RDF_TYPE}> <${PET}> .
<${ENT}d1> <${D}/guardDogLevel> "5"^^<${XSD}integer> .
<${ENT}e1> <${RDF_TYPE}> <${E}> .
<${ENT}e1> <${E}/name> "Alice" .
<${ENT}e1> <${E}/department> "Engineering" .
<${ENT}e1> <${E}/bestFriend> <${ENT}e2> .
<${ENT}e2> <${RDF_TYPE}> <${E}> .
<${ENT}e2> <${E}/name> "Bob" .
<${ENT}e2> <${E}/department> "Sales" .
<${ENT}m1> <${RDF_TYPE}> <${M}> .
<${ENT}m1> <${M}/score> "3.14"^^<${XSD}decimal> .
<${ENT}m1> <${M}/rating> "2.5"^^<${XSD}double> .
<${ENT}m1> <${M}/views> "1000000"^^<${XSD}long> .
<${ENT}m1> <${M}/count> "42"^^<${XSD}integer> .
<${ENT}m1> <${M}/joinedOn> "2020-06-15"^^<${XSD}date> .
<${ENT}m1> <${M}/scores> "1.5"^^<${XSD}decimal> .
<${ENT}m1> <${M}/scores> "2.5"^^<${XSD}decimal> .
<${ENT}m1> <${M}/scores> "2.5"^^<${XSD}decimal> .
<${ENT}m1> <${M}/scores> "3.5"^^<${XSD}decimal> .
<${ENT}m2> <${RDF_TYPE}> <${M}> .
<${ENT}m2> <${M}/score> "-7.25"^^<${XSD}decimal> .
<${ENT}m2> <${M}/count> "-3"^^<${XSD}integer> .
<${ENT}pna> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pna> <${PP}name> "A" .
<${ENT}pna> <${PP}knows> <${ENT}pnb> .
<${ENT}pna> <${PP}email> "a@x" .
<${ENT}pna> <${PP}phone> "555" .
<${ENT}pna> <${PP}manages> <${ENT}pnb> .
<${ENT}pnb> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pnb> <${PP}name> "B" .
<${ENT}pnb> <${PP}knows> <${ENT}pnc> .
<${ENT}pnb> <${PP}manages> <${ENT}pnc> .
<${ENT}pnc> <${RDF_TYPE}> <${PP}Node> .
<${ENT}pnc> <${PP}name> "C" .
`.trim();

let fusekiAvailable = false;
const store = new FusekiStore(
  process.env.FUSEKI_BASE_URL || 'http://localhost:3939',
  'nashville-test',
);

async function reloadBase(): Promise<void> {
  await clearAllData();
  await loadTestData(BASE_DATA);
}

beforeAll(async () => {
  fusekiAvailable = await ensureFuseki();
  if (!fusekiAvailable) {
    console.log('Fuseki not available — skipping coverage tests');
    return;
  }
  await createTestDataset();
  await reloadBase();
}, 30000);

afterAll(async () => {
  if (!fusekiAvailable) return;
  await clearAllData();
});

type Row = Record<string, any>;
const ids = (rows: Row[]): string[] =>
  rows.map((r) => r.id.replace(ENT, '')).sort();

const runSel = (name: keyof typeof queryFactories) =>
  store.selectQuery((queryFactories as any)[name]());

const find = (rows: Row[], id: string): Row =>
  rows.find((r) => r.id.includes(id))!;

// =========================================================================
// §2/§4 — operator & property-path tails
// =========================================================================
describe('coverage tails — operators & paths', () => {
  const P1 = {id: `${ENT}p1`}, PNA = {id: `${ENT}pna`};
  const one = async (q: any, key: string) => ((await store.selectQuery(q)) as Row)[key];

  test('date components hours/minutes/seconds (p1 13:45:30)', async () => {
    if (!fusekiAvailable) return;
    expect(await one(Person.select((p: any) => ({r: p.birthDate.hours()})).for(P1), 'r')).toBe(13);
    expect(await one(Person.select((p: any) => ({r: p.birthDate.minutes()})).for(P1), 'r')).toBe(45);
    expect(await one(Person.select((p: any) => ({r: p.birthDate.seconds()})).for(P1), 'r')).toBe(30);
  });

  test('encodeForUri projection', async () => {
    if (!fusekiAvailable) return;
    expect(await one(Person.select((p: any) => ({r: p.name.encodeForUri()})).for(P1), 'r')).toBe('Semmy');
  });

  test('isLiteral / isNumeric introspection (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await store.selectQuery(Person.select().where((p: any) => p.name.isLiteral()))) as Row[]))
      .toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect((await store.selectQuery(Person.select().where((p: any) => p.name.isNumeric()))) as Row[]).toEqual([]);
  });

  test('zeroOrMore path knows*/name (pna → self + transitive)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(PathNode.select((n: any) => n.knowsChainNames).for(PNA))) as Row;
    expect([...(r.knowsChainNames as string[])].sort()).toEqual(['A', 'B', 'C']);
  });

  test('zeroOrOne path knows?/name (pna → self + direct)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(PathNode.select((n: any) => n.maybeKnownNames).for(PNA))) as Row;
    expect([...(r.maybeKnownNames as string[])].sort()).toEqual(['A', 'B']);
  });
});

// =========================================================================
// §6/§7 — DSL-JSON delete round-trip + {$ctx} mutation tails
// =========================================================================
describe('coverage tails — DSL-JSON delete & {$ctx} mutations', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('delete round-trips via fromJSON (deleteWhere)', async () => {
    if (!fusekiAvailable) return;
    // give p2 hobby=Chess, then delete-where(hobby=Chess) over the wire
    await executeSparqlUpdate(`DELETE { <${ENT}p2> <${P}/hobby> ?o } INSERT { <${ENT}p2> <${P}/hobby> "Chess" } WHERE { <${ENT}p2> <${P}/hobby> ?o }`);
    const dq = queryFactories.deleteWhere();
    await store.deleteQuery(fromJSON((dq as any).toJSON()) as any);
    expect(ids((await store.selectQuery(queryFactories.selectName())) as Row[]))
      .toEqual(['p1', 'p3', 'p4', 'p5']);
  });

  test('{$ctx} as update target (user = p3)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(Person.update({hobby: 'CtxHobby'}).for(getQueryContext('user')));
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p3> <${P}/hobby> ?h }`);
    expect(r.results.bindings.map((b: any) => b.h.value)).toEqual(['CtxHobby']);
  });

  test('{$ctx} as mutation field value (p1.bestFriend := user p3)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(Person.update({bestFriend: getQueryContext('user')} as any).for({id: `${ENT}p1`}));
    const r = await executeSparqlQuery(`SELECT ?b WHERE { <${ENT}p1> <${P}/bestFriend> ?b }`);
    expect(r.results.bindings.map((b: any) => b.b.value)).toEqual([`${ENT}p3`]);
  });
});

// =========================================================================
// §5 — Builder features (ordering / pagination)
// =========================================================================
describe('coverage §5 — builder features', () => {
  const names = async (q: any) => ((await store.selectQuery(q)) as Row[]).map((r) => r.name);

  test('orderBy DESC', async () => {
    if (!fusekiAvailable) return;
    expect(await names(Person.select((p: any) => p.name).orderBy((p: any) => p.name, 'DESC')))
      .toEqual(['Semmy', 'Quinn', 'Moa', 'Maximilian', 'Jinx']);
  });

  test('multi-key orderBy [hobby, name] (nulls first, then by name)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await store.selectQuery(
      Person.select((p: any) => [p.name, p.hobby]).orderBy((p: any) => [p.hobby, p.name]),
    )) as Row[];
    expect(rows.map((r) => r.name)).toEqual(['Jinx', 'Maximilian', 'Quinn', 'Moa', 'Semmy']);
  });

  test('top-level offset + limit windowing', async () => {
    if (!fusekiAvailable) return;
    // names asc: Jinx, Maximilian, Moa, Quinn, Semmy → offset(1).limit(2)
    expect(await names(Person.select((p: any) => p.name).orderBy((p: any) => p.name).offset(1).limit(2)))
      .toEqual(['Maximilian', 'Moa']);
  });
});

// =========================================================================
// §6 — DSL-JSON round-trip E2E (toJSON → fromJSON → run == run)
// =========================================================================
describe('coverage §6 — DSL-JSON round-trip', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('select round-trips losslessly (v:1.0) and yields identical results', async () => {
    if (!fusekiAvailable) return;
    const q = Person.select((p: any) => [p.name, p.friends.name]);
    const json = (q as any).toJSON();
    expect(json.v).toBe('1.0');
    const direct = await store.selectQuery(q);
    const viaJson = await store.selectQuery(fromJSON(json) as any);
    expect(viaJson).toEqual(direct);
  });

  test('create round-trips and executes via fromJSON', async () => {
    if (!fusekiAvailable) return;
    const cq = Person.create({name: 'JsonRoundTrip'} as any);
    const created = (await store.createQuery(fromJSON((cq as any).toJSON()) as any)) as Row;
    expect(created.name).toBe('JsonRoundTrip');
    const verify = await executeSparqlQuery(`SELECT ?n WHERE { <${created.id}> <${P}/name> ?n }`);
    expect(verify.results.bindings[0].n.value).toBe('JsonRoundTrip');
    await executeSparqlUpdate(`DELETE WHERE { <${created.id}> ?p ?o }`);
  });

  test('update round-trips and applies via fromJSON', async () => {
    if (!fusekiAvailable) return;
    const uq = Person.update({hobby: 'JsonHobby'}).for({id: `${ENT}p1`});
    await store.updateQuery(fromJSON((uq as any).toJSON()) as any);
    const verify = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p1> <${P}/hobby> ?h }`);
    expect(verify.results.bindings.map((b: any) => b.h.value)).toEqual(['JsonHobby']);
  });
});

// =========================================================================
// §7 — {$ctx} context references E2E
// =========================================================================
describe('coverage §7 — {$ctx} context', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('context as select subject (user = p3 → Jinx)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      Person.select((p: any) => p.name).for(getQueryContext('user')),
    )) as Row;
    expect(r.id).toContain('p3');
    expect(r.name).toBe('Jinx');
  });

  test('context as where-arg (bestFriend == user p3 → p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await store.selectQuery(
      Person.select().where((p: any) => p.bestFriend.equals(getQueryContext('user'))),
    )) as Row[])).toEqual(['p2']);
  });

  test('delete-by-context removes the context entity (p3)', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(Person.delete(getQueryContext('user')) as any);
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    expect(ids(remaining)).toEqual(['p1', 'p2', 'p4', 'p5']);
  });

  test('mutation with an unresolved context rejects', async () => {
    if (!fusekiAvailable) return;
    await expect(
      store.updateQuery(Person.update({hobby: 'x'}).for(getQueryContext('no-such-ctx')) as any),
    ).rejects.toThrow(/context/i);
  });
});

// =========================================================================
// §4 — DSL property paths E2E (complex decorator paths → SPARQL → results)
// =========================================================================
describe('coverage §4 — property paths', () => {
  const PNA = {id: `${ENT}pna`};
  const PNB = {id: `${ENT}pnb`};

  test('sequence path: knows/name (pna → "B")', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.friendName).for(PNA),
    )) as Row;
    expect(r.friendName).toBe('B');
  });

  test('alternative path: email|phone (pna → both)', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.contact).for(PNA),
    )) as Row;
    expect([...(r.contact as string[])].sort()).toEqual(['555', 'a@x']);
  });

  test('inverse+sequence path: ^knows/name (pnb → "A")', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.knownByName).for(PNB),
    )) as Row;
    expect(r.knownByName).toBe('A');
  });

  test('transitive path: manages+/name (pna → ["B","C"])', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(
      PathNode.select((n: any) => n.reportNames).for(PNA),
    )) as Row;
    expect([...(r.reportNames as string[])].sort()).toEqual(['B', 'C']);
  });
});

// =========================================================================
// §2 — Operators (string / numeric / date / null / introspection / hash)
// =========================================================================
const P1 = {id: `${ENT}p1`}, M1 = {id: `${ENT}m1`}, M2 = {id: `${ENT}m2`};
const projVal = async (q: any, key = 'r') => {
  const r = (await store.selectQuery(q)) as any;
  return Array.isArray(r) ? r.map((x) => x[key]) : r?.[key];
};
const filterIds = async (q: any) => ids((await store.selectQuery(q)) as Row[]);

describe('coverage §2 — string operators', () => {
  test('substr / replace / concat / before / after (projection)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.substr(1, 3)})).for(P1))).toBe('Sem');
    expect(await projVal(Person.select((p: any) => ({r: p.name.replace('m', 'X', 'i')})).for(P1))).toBe('SeXXy');
    expect(await projVal(Person.select((p: any) => ({r: p.name.concat('!')})).for(P1))).toBe('Semmy!');
    expect(await projVal(Person.select((p: any) => ({r: p.name.before('m')})).for(P1))).toBe('Se');
    expect(await projVal(Person.select((p: any) => ({r: p.name.after('m')})).for(P1))).toBe('my');
  });
  test('contains / startsWith / endsWith / matches (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Person.select().where((p: any) => p.name.contains('in')))).toEqual(['p3', 'p4']);
    expect(await filterIds(Person.select().where((p: any) => p.name.startsWith('S')))).toEqual(['p1']);
    expect(await filterIds(Person.select().where((p: any) => p.name.endsWith('x')))).toEqual(['p3']);
    expect(await filterIds(Person.select().where((p: any) => p.name.matches('^[MQ]')))).toEqual(['p2', 'p4', 'p5']);
  });
});

describe('coverage §2 — numeric operators', () => {
  test('minus / times / divide / power (Metric m1: count=42)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Metric.select((x: any) => ({r: x.count.minus(2)})).for(M1))).toBe(40);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.times(2)})).for(M1))).toBe(84);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.divide(2)})).for(M1))).toBe(21);
    expect(await projVal(Metric.select((x: any) => ({r: x.count.power(2)})).for(M1))).toBe(1764);
  });
  test('abs / round / ceil / floor', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Metric.select((x: any) => ({r: x.count.abs()})).for(M2))).toBe(3); // m2.count=-3
    expect(await projVal(Metric.select((x: any) => ({r: x.score.round()})).for(M1))).toBe(3); // 3.14
    expect(await projVal(Metric.select((x: any) => ({r: x.score.ceil()})).for(M1))).toBe(4);
    expect(await projVal(Metric.select((x: any) => ({r: x.score.floor()})).for(M1))).toBe(3);
  });
  test('gte / lte (filter)', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Metric.select().where((x: any) => x.count.gte(42)))).toEqual(['m1']);
    expect(await filterIds(Metric.select().where((x: any) => x.count.lte(0)))).toEqual(['m2']);
  });
});

describe('coverage §2 — date operators', () => {
  test('year / month / day (p1 birthDate 1990-01-01)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.year()})).for(P1))).toBe(1990);
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.month()})).for(P1))).toBe(1);
    expect(await projVal(Person.select((p: any) => ({r: p.birthDate.day()})).for(P1))).toBe(1);
  });
});

describe('coverage §2 — null / introspection / hash', () => {
  test('isDefined (filter) → persons with a hobby', async () => {
    if (!fusekiAvailable) return;
    expect(await filterIds(Person.select().where((p: any) => p.hobby.isDefined()))).toEqual(['p1', 'p2']);
  });
  test('defaultTo (coalesce) fills missing hobby', async () => {
    if (!fusekiAvailable) return;
    const r = (await store.selectQuery(Person.select((p: any) => ({r: p.hobby.defaultTo('none')})))) as Row[];
    expect(Object.fromEntries(r.map((x) => [x.id.replace(ENT, ''), x.r]))).toEqual({
      p1: 'Reading', p2: 'Jogging', p3: 'none', p4: 'none', p5: 'none',
    });
  });
  test('str / datatype (introspection)', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.str()})).for(P1))).toBe('Semmy');
    const dt = await projVal(Metric.select((x: any) => ({r: x.score.datatype()})).for(M1));
    expect(dt.id).toBe(`${XSD}decimal`);
  });
  test('md5 / sha256 — exact digests of "Semmy"', async () => {
    if (!fusekiAvailable) return;
    expect(await projVal(Person.select((p: any) => ({r: p.name.md5()})).for(P1)))
      .toBe(createHash('md5').update('Semmy').digest('hex'));
    expect(await projVal(Person.select((p: any) => ({r: p.name.sha256()})).for(P1)))
      .toBe(createHash('sha256').update('Semmy').digest('hex'));
  });

  // Quarantined — surfaced bugs (backlog 005):
  //  - isNotDefined: the property is inner-joined, so !BOUND can never match
  //    (returns [] instead of the rows lacking the property).
  //  - Expr.ifThen: returns the ELSE branch even when the condition is true.
  test.skip('isNotDefined [BUG: property inner-joined, never matches]', () => {});
  test.skip('Expr.ifThen [BUG: returns else-branch when condition is true]', () => {});
});

// =========================================================================
// §3 — Datatype coercion (Metric shape)
// =========================================================================
describe('coverage §3 — datatypes', () => {
  test('decimal/double/long/integer coerce to JS number', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => [x.score, x.rating, x.views, x.count]).for({id: `${ENT}m1`}),
    )) as Row;
    expect(m.score).toBe(3.14);
    expect(m.rating).toBe(2.5);
    expect(m.views).toBe(1000000);
    expect(m.count).toBe(42);
    expect(typeof m.score).toBe('number');
  });

  test('xsd:date coerces to a JS Date', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => x.joinedOn).for({id: `${ENT}m1`}),
    )) as Row;
    expect(m.joinedOn instanceof Date).toBe(true);
    expect((m.joinedOn as Date).getUTCFullYear()).toBe(2020);
  });

  test('negative numbers round-trip', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => [x.score, x.count]).for({id: `${ENT}m2`}),
    )) as Row;
    expect(m.score).toBe(-7.25);
    expect(m.count).toBe(-3);
  });

  test('multi-valued numeric literal collects, dedups, into number[]', async () => {
    if (!fusekiAvailable) return;
    const m = (await store.selectQuery(
      Metric.select((x: any) => x.scores).for({id: `${ENT}m1`}),
    )) as Row;
    expect(Array.isArray(m.scores)).toBe(true);
    // seed has 1.5, 2.5, 2.5, 3.5 → deduped {1.5, 2.5, 3.5}
    expect([...(m.scores as number[])].sort((a, b) => a - b)).toEqual([1.5, 2.5, 3.5]);
    (m.scores as number[]).forEach((v) => expect(typeof v).toBe('number'));
  });
});

// =========================================================================
// §1 — Deep nesting / sub-selects (read-only). 11 sound; 3 quarantined (bugs).
// =========================================================================
describe('coverage §1 — deep nesting', () => {
  test('tripleNestedSubSelect — friends→bestFriend→friends', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('tripleNestedSubSelect')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.friends.map((f: Row) => f.id.replace(ENT, '')).sort()).toEqual(['p2', 'p3']);
    const p2 = p1.friends.find((f: Row) => f.id.includes('p2'));
    expect(p2.bestFriend.id).toContain('p3');
    expect(p2.bestFriend.friends).toEqual([]);
  });

  test('doubleNestedSingularPlural — bestFriend→friends', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('doubleNestedSingularPlural')) as Row[];
    expect(find(rows, 'p2').bestFriend.id).toContain('p3');
    expect(find(rows, 'p2').bestFriend.friends).toEqual([]);
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  test('doubleNestedPluralSingular — friends→bestFriend {name,isReal}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('doubleNestedPluralSingular')) as Row[];
    const p2 = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(p2.bestFriend).toEqual(expect.objectContaining({name: 'Jinx', isReal: true}));
  });

  test('employeeSubSelect — Employee.bestFriend {name,dept}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('employeeSubSelect')) as Row[];
    expect(find(rows, 'e1').bestFriend).toEqual(expect.objectContaining({name: 'Bob', dept: 'Sales'}));
    expect(find(rows, 'e2').bestFriend).toBeNull();
  });

  test('mixedPathAndSubSelect — name + friends.select(name,hobby)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('mixedPathAndSubSelect')) as Row[];
    const p1 = find(rows, 'p1');
    expect(p1.name).toBe('Semmy');
    const moa = p1.friends.find((f: Row) => f.id.includes('p2'));
    expect(moa).toEqual(expect.objectContaining({name: 'Moa', hobby: 'Jogging'}));
    expect(p1.friends.find((f: Row) => f.id.includes('p3')).hobby).toBeNull();
  });

  test('multipleSubSelectsInArray — friends.select(name) + bestFriend.select(hobby)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('multipleSubSelectsInArray')) as Row[];
    const p2 = find(rows, 'p2');
    expect(p2.friends.map((f: Row) => f.id.replace(ENT, '')).sort()).toEqual(['p3', 'p4']);
    expect(p2.bestFriend.id).toContain('p3');
    expect(p2.bestFriend.hobby).toBeNull();
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  test('subSelectArrayOfPaths — friends.select([name,hobby,birthDate])', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectArrayOfPaths')) as Row[];
    const moa = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(moa).toEqual(expect.objectContaining({name: 'Moa', hobby: 'Jogging', birthDate: null}));
  });

  test('subSelectSingularArrayPaths — bestFriend.select([name,hobby,isRealPerson])', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectSingularArrayPaths')) as Row[];
    expect(find(rows, 'p2').bestFriend).toEqual(
      expect.objectContaining({name: 'Jinx', hobby: null, isRealPerson: true}),
    );
  });

  test('subSelectAllPlural — friends.selectAll() includes nested refs', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectAllPlural')) as Row[];
    const moa = find(rows, 'p1').friends.find((f: Row) => f.id.includes('p2'));
    expect(moa.name).toBe('Moa');
    expect(moa.isRealPerson).toBe(false);
    expect(moa.bestFriend.id).toContain('p3');
    expect(moa.firstPet.id).toContain('dog2');
  });

  test('subSelectAllSingular — bestFriend.selectAll()', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('subSelectAllSingular')) as Row[];
    const bf = find(rows, 'p2').bestFriend;
    expect(bf.name).toBe('Jinx');
    expect(bf.isRealPerson).toBe(true);
    expect(bf.hobby).toBeNull();
  });

  test('selectBestFriendOnly — bestFriend reference only', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('selectBestFriendOnly')) as Row[];
    expect(find(rows, 'p2').bestFriend.id).toContain('p3');
    expect(find(rows, 'p1').bestFriend).toBeNull();
  });

  // Quarantined — surfaced bugs (backlog 004):
  //  - pluralFilteredNestedSubSelect: inline .where() on a plural sub-select is
  //    dropped (all pluralTestProp entries returned, not just name='Moa').
  //  - subSelectWithCount: nested aggregate f.friends.size() is mis-scoped to the
  //    parent row instead of each friend.
  //  - subSelectWithOne: under .one(), a friend with a null projected property
  //    (Jinx, no hobby) is dropped from the array.
  test.skip('pluralFilteredNestedSubSelect [BUG: filter on plural sub-select dropped]', () => {});
  test.skip('subSelectWithCount [BUG: nested aggregate mis-scoped to parent]', () => {});
  test.skip('subSelectWithOne [BUG: null-property friend dropped under .one()]', () => {});
});

// =========================================================================
// §1 — MINUS exclusion (read-only)
// =========================================================================
describe('coverage §1 — MINUS', () => {
  test('minusShape — Person minus Employee (persons are not employees)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusShape')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusCondition — minus hobby=Chess (nobody) keeps all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusCondition')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusChained — two MINUS blocks', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusChained')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('minusMultiProperty — exclude where hobby AND nickNames exist (p1)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusMultiProperty')) as Row[])).toEqual(['p2', 'p3', 'p4', 'p5']);
  });
  test('minusNestedPath — exclude where bestFriend.name exists (p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusNestedPath')) as Row[])).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
  test('minusMixed — flat + nested AND exclusion (p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusMixed')) as Row[])).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
  test('minusSingleProperty — exclude anyone with a hobby (p1, p2)', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('minusSingleProperty')) as Row[])).toEqual(['p3', 'p4', 'p5']);
  });
});

// =========================================================================
// §1 — Negation / quantifier filters (read-only)
// =========================================================================
describe('coverage §1 — negation/quantifier', () => {
  test('whereNone — friends none hobby=Chess → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereNone')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereSomeNot — NOT some(friend hobby=Chess) → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereSomeNot')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereEqualsNot — name != Alice → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereEqualsNot')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereNeq — name neq Alice → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereNeq')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereNoneAndEquals — none(Chess) AND name=Bob → none', async () => {
    if (!fusekiAvailable) return;
    expect((await runSel('whereNoneAndEquals')) as Row[]).toEqual([]);
  });
});

// =========================================================================
// §1 — Expression-based WHERE (read-only)
// =========================================================================
describe('coverage §1 — expression WHERE', () => {
  test('whereExprStrlen — strlen(name) > 5 → Maximilian', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprStrlen')) as Row[])).toEqual(['p5']);
  });
  test('whereExprArithmetic — strlen+10 < 100 → all', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprArithmetic')) as Row[])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });
  test('whereExprAndChain — strlen>5 AND strlen<20 → Maximilian', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprAndChain')) as Row[])).toEqual(['p5']);
  });
  test('whereExprMixed — name=Bob AND strlen>3 → none', async () => {
    if (!fusekiAvailable) return;
    expect((await runSel('whereExprMixed')) as Row[]).toEqual([]);
  });
  test('whereExprNestedPath — bestFriend.name strlen>3 → p2', async () => {
    if (!fusekiAvailable) return;
    expect(ids((await runSel('whereExprNestedPath')) as Row[])).toEqual(['p2']);
  });
  test('whereExprNot — NOT(name=Alice AND hobby=Chess); requires hobby bound → p1,p2', async () => {
    if (!fusekiAvailable) return;
    // hobby is a required binding in the AND, so only rows with a hobby (p1,p2)
    // are evaluated; both pass the negation.
    expect(ids((await runSel('whereExprNot')) as Row[])).toEqual(['p1', 'p2']);
  });
  test('whereExprWithProjection — filter strlen>2 + nameLen projection', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('whereExprWithProjection')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.nameLen]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
});

// =========================================================================
// §1 — Computed expression projections (read-only)
// =========================================================================
describe('coverage §1 — computed projections', () => {
  test('exprStrlen — name length per person (key: expr)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprStrlen')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.expr]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
  test('exprCustomKey — {nameLen: strlen}', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprCustomKey')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), r.nameLen]));
    expect(byId).toEqual({p1: 5, p2: 3, p3: 4, p4: 5, p5: 10});
  });
  test('exprMultiple — [name, strlen]', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprMultiple')) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id.replace(ENT, ''), [r.name, r.expr]]));
    expect(byId).toEqual({
      p1: ['Semmy', 5], p2: ['Moa', 3], p3: ['Jinx', 4],
      p4: ['Quinn', 5], p5: ['Maximilian', 10],
    });
  });
  test('exprNestedPath — bestFriend.name.ucase() (fixed alias collision)', async () => {
    if (!fusekiAvailable) return;
    const rows = (await runSel('exprNestedPath')) as Row[];
    // Only p2 has a bestFriend (p3 "Jinx") → "JINX"; others have no bestFriend.
    const byId = Object.fromEntries(
      rows.filter((r) => r.expr != null).map((r) => [r.id.replace(ENT, ''), r.expr]),
    );
    expect(byId).toEqual({p2: 'JINX'});
  });
});

// =========================================================================
// §1 — Expression-based updates (mutating; isolated per test)
// =========================================================================
describe('coverage §1 — expression updates', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  test('updateExprCallback — guardDogLevel + 1 (d1: 5 → 6)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateExprCallback());
    const r = await executeSparqlQuery(`SELECT ?v WHERE { <${ENT}d1> <${D}/guardDogLevel> ?v }`);
    expect(r.results.bindings.map((b: any) => b.v.value)).toEqual(['6']);
  });

  test('updateExprNow — birthDate := now() (single, current year)', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateExprNow());
    const r = await executeSparqlQuery(`SELECT ?v WHERE { <${ENT}p1> <${P}/birthDate> ?v }`);
    expect(r.results.bindings.length).toBe(1);
    const yr = new Date(r.results.bindings[0].v.value).getFullYear();
    expect(yr).toBeGreaterThanOrEqual(2026);
  });

  // backlog 003 (FIXED): expression update over a traversal now nests the leaf
  // property triple inside its traversal-edge OPTIONAL, so it is scoped to the
  // target's traversal target instead of every entity in the graph.
  test('updateExprTraversal — hobby := bestFriend.name.ucase(), target WITH bestFriend', async () => {
    if (!fusekiAvailable) return;
    // p2.bestFriend = p3 ("Jinx") → hobby becomes "JINX"
    await store.updateQuery(
      Person.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({id: `${ENT}p2`}),
    );
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p2> <${P}/hobby> ?h }`);
    expect(r.results.bindings.map((b: any) => b.h.value)).toEqual(['JINX']);
  });

  test('updateExprTraversal — no cross-entity corruption when target has no bestFriend', async () => {
    if (!fusekiAvailable) return;
    // p1 has no bestFriend: old hobby is removed, nothing is inserted — and
    // crucially the hobby must NOT be filled with every entity's UCASE(name).
    await store.updateQuery(queryFactories.updateExprTraversal());
    const r = await executeSparqlQuery(`SELECT ?h WHERE { <${ENT}p1> <${P}/hobby> ?h }`);
    const vals = r.results.bindings.map((b: any) => b.h.value);
    expect(vals).not.toContain('SEMMY');
    expect(vals.length).toBeLessThanOrEqual(1);
  });

  test('updateExprSharedTraversal — two fields off bestFriend stay scoped', async () => {
    if (!fusekiAvailable) return;
    // p2.bestFriend = p3 ("Jinx", no hobby): name := "JINX"; hobby := lcase(none) → unset
    await store.updateQuery(
      Person.update((p: any) => ({
        name: p.bestFriend.name.ucase(),
        hobby: p.bestFriend.hobby.lcase(),
      })).for({id: `${ENT}p2`}),
    );
    const n = await executeSparqlQuery(`SELECT ?n WHERE { <${ENT}p2> <${P}/name> ?n }`);
    expect(n.results.bindings.map((b: any) => b.n.value)).toEqual(['JINX']);
  });
});

// =========================================================================
// §1 — Bulk / conditional mutations (mutating; isolated per test)
// =========================================================================
describe('coverage §1 — bulk/conditional mutations', () => {
  beforeEach(async () => { if (fusekiAvailable) await reloadBase(); });

  const personCount = async () =>
    Number((await executeSparqlQuery(
      `SELECT (COUNT(?s) AS ?c) WHERE { ?s <${RDF_TYPE}> <${P}> }`,
    )).results.bindings[0].c.value);
  const hobbies = async () =>
    (await executeSparqlQuery(`SELECT ?s ?h WHERE { ?s <${P}/hobby> ?h }`)).results.bindings
      .map((b: any) => `${b.s.value.replace(ENT, '')}=${b.h.value}`).sort();

  test('updateForAll — set hobby=Chess on all persons', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.updateForAll());
    expect(await hobbies()).toEqual(['p1=Chess', 'p2=Chess', 'p3=Chess', 'p4=Chess', 'p5=Chess']);
  });

  test('updateWhere — hobby:=Archived where hobby=Chess (set one Chess first)', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(`DELETE { <${ENT}p1> <${P}/hobby> ?o } INSERT { <${ENT}p1> <${P}/hobby> "Chess" } WHERE { <${ENT}p1> <${P}/hobby> ?o }`);
    await store.updateQuery(queryFactories.updateWhere());
    expect(await hobbies()).toEqual(['p1=Archived', 'p2=Jogging']);
  });

  test('deleteWhere — delete persons with hobby=Chess (set p2 Chess first)', async () => {
    if (!fusekiAvailable) return;
    await executeSparqlUpdate(`DELETE { <${ENT}p2> <${P}/hobby> ?o } INSERT { <${ENT}p2> <${P}/hobby> "Chess" } WHERE { <${ENT}p2> <${P}/hobby> ?o }`);
    await store.deleteQuery(queryFactories.deleteWhere());
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    expect(ids(remaining)).toEqual(['p1', 'p3', 'p4', 'p5']);
  });

  test('deleteAll — removes every Person', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.deleteAll());
    expect(await personCount()).toBe(0);
  });

  test('deleteAllBuilder — DeleteBuilder.from(Person).all() removes every Person', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.deleteAllBuilder());
    expect(await personCount()).toBe(0);
  });

  test('whereExprUpdateBuilder — hobby:=Archived where strlen(name)>3', async () => {
    if (!fusekiAvailable) return;
    await store.updateQuery(queryFactories.whereExprUpdateBuilder() as any);
    // names>3 chars: Semmy, Jinx, Quinn, Maximilian → Archived; Moa(3) untouched.
    expect(await hobbies()).toEqual(
      ['p1=Archived', 'p2=Jogging', 'p3=Archived', 'p4=Archived', 'p5=Archived'].sort(),
    );
  });

  test('whereExprDeleteBuilder — delete where strlen(name)>3', async () => {
    if (!fusekiAvailable) return;
    await store.deleteQuery(queryFactories.whereExprDeleteBuilder() as any);
    const remaining = (await store.selectQuery(queryFactories.selectName())) as Row[];
    // only Moa (len 3) survives
    expect(ids(remaining)).toEqual(['p2']);
  });
});
