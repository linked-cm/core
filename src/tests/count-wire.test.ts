/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The DSL-JSON wire form of a count query, and the dispatch contract behind it.
 *
 * A count travels as its own envelope, discriminated by `op: 'count'` — the same
 * field ask and mutations use. It carries a pattern and nothing else, so there is no
 * `fields`, `limit`, `offset`, `sortBy` or `one` for a receiver to validate or
 * ignore. Unlike an ask, `shape` is required: a shapeless count would count every
 * node in the store.
 *
 * The dispatch half matters as much as the format: a count that reports a broken
 * store as `0` renders an empty table that is indistinguishable from real data, so
 * every failure mode below must *reject*.
 */
import {describe, expect, test, beforeAll} from '@jest/globals';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {CountBuilder, isCountQuery} from '../queries/CountBuilder';
import {SelectBuilder} from '../queries/QueryBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {resolveCount} from '../queries/queryDispatch';
import {countToSparql} from '../sparql/irToAlgebra';
import {mapSparqlCountResult} from '../sparql/resultMapping';
import {setQueryContext, PendingQueryContext} from '../queries/QueryContext';
// Imported for its side effect: it installs the global query dispatch that the
// PromiseLike (`await builder`) path below uses.
import '../test-helpers/query-capture-store';
import {WIRE_VERSION} from '../queries/wireVersion';
import type {IRCountQuery} from '../queries/IntermediateRepresentation';
import type {CountQuery} from '../queries/CountQuery';

import '../ontologies/rdf';
import '../ontologies/xsd';

const entity = (s: string) => ({id: `${tmpEntityBase}${s}`});

beforeAll(() => {
  setQueryContext('user', {id: 'user-1'}, Person);
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('count envelope — shape', () => {
  test('a count by subject', () => {
    expect(SelectBuilder.from(Person).for(entity('p1')).toCount().toJSON()).toEqual({
      v: WIRE_VERSION,
      op: 'count',
      shape: Person.shape.id,
      subject: entity('p1').id,
    });
  });

  test('a where clause rides along; no answer-shaping fields appear', () => {
    const json = SelectBuilder.from(Person)
      .select((p) => [p.name])
      .where((p) => p.name.equals('Semmy'))
      .orderBy((p) => p.name)
      .limit(20)
      .offset(40)
      .toCount()
      .toJSON();
    expect(json.op).toBe('count');
    expect(json.shape).toBe(Person.shape.id);
    expect(json.where).toBeDefined();
    // The window, the projection and the sort are not merely undefined — the
    // envelope type has no field for them.
    for (const key of ['fields', 'limit', 'offset', 'sortBy', 'one']) {
      expect(Object.keys(json)).not.toContain(key);
    }
  });

  test('a pending context subject travels as a reference, not as a resolved IRI', () => {
    // Narrowing it here would resolve it against THIS process's context map, and the
    // count would travel as a concrete IRI where the equivalent select travels as
    // `{"@ctx": name}` for the receiver to resolve.
    const json = SelectBuilder.from(Person)
      .for(new PendingQueryContext('user'))
      .toCount()
      .toJSON();
    expect(json.subject).toEqual({'@ctx': 'user'});
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('count envelope — round trip', () => {
  test('fromJSON routes `op: count` to a CountBuilder', () => {
    const json = SelectBuilder.from(Person)
      .where((p) => p.name.equals('Semmy'))
      .toCount()
      .toJSON();
    const rehydrated = fromJSON(json);
    expect(rehydrated).toBeInstanceOf(CountBuilder);
    expect(isCountQuery(rehydrated)).toBe(true);
  });

  test('the round trip is IR-identical', () => {
    const original = SelectBuilder.from(Person)
      .where((p) => p.name.equals('Semmy'))
      .minus((p) => p.hobby)
      .toCount();
    const rehydrated = fromJSON(original.toJSON()) as CountBuilder;
    expect(lower(rehydrated)).toEqual(lower(original));
    expect(countToSparql(lower(rehydrated))).toBe(countToSparql(lower(original)));
  });

  test('the round trip is envelope-identical', () => {
    const json = SelectBuilder.from(Person).for(entity('p1')).toCount().toJSON();
    expect((fromJSON(json) as CountBuilder).toJSON()).toEqual(json);
  });

  test('an envelope with no shape is refused', () => {
    expect(() =>
      CountBuilder.fromJSON({v: WIRE_VERSION, op: 'count'} as never),
    ).toThrow(/must name a `shape`/);
  });

  test('an unknown op is still refused, not read as a select', () => {
    expect(() => fromJSON({v: WIRE_VERSION, op: 'tally'} as never)).toThrow(
      /Unknown query op "tally"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch contract — resolveCount
// ---------------------------------------------------------------------------

describe('resolveCount contract', () => {
  const query = SelectBuilder.from(Person).toCount() as unknown as CountQuery;

  test('a real count is returned', async () => {
    await expect(resolveCount({countQuery: async () => 42}, query)).resolves.toBe(42);
  });

  test('0 is a real answer, not an error', async () => {
    await expect(resolveCount({countQuery: async () => 0}, query)).resolves.toBe(0);
  });

  test('a store with no countQuery rejects, naming the method', async () => {
    await expect(resolveCount({}, query)).rejects.toThrow(/IDataset\.countQuery/);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '42'],
    ['NaN', NaN],
    ['a float', 1.5],
    ['a negative', -1],
  ])('%s is rejected, never coerced', async (_label, answer) => {
    await expect(
      resolveCount({countQuery: async () => answer as never}, query),
    ).rejects.toThrow(/non-negative integer/);
  });

  test('a store failure rejects — it is never reported as 0', async () => {
    await expect(
      resolveCount(
        {
          countQuery: async () => {
            throw new Error('store unreachable');
          },
        },
        query,
      ),
    ).rejects.toThrow('store unreachable');
  });
});

// ---------------------------------------------------------------------------
// exec() — the answers given without querying
// ---------------------------------------------------------------------------

describe('count exec — no subject to count', () => {
  test('.for(null) answers 0 without dispatching', async () => {
    let dispatched = false;
    const target = {
      countQuery: async () => {
        dispatched = true;
        return 7;
      },
    };
    const answer = await SelectBuilder.from(Person)
      .for(null)
      .toCount()
      .exec(target as never);
    expect(answer).toBe(0);
    expect(dispatched).toBe(false);
  });

  test('an unresolved pending-context subject answers 0 without dispatching', async () => {
    let dispatched = false;
    const target = {
      countQuery: async () => {
        dispatched = true;
        return 7;
      },
    };
    const answer = await SelectBuilder.from(Person)
      .for(new PendingQueryContext('nobody-set-this'))
      .toCount()
      .exec(target as never);
    expect(answer).toBe(0);
    expect(dispatched).toBe(false);
  });

  test('.count(target) goes through the target dataset', async () => {
    const target = {countQuery: async () => 11};
    await expect(
      SelectBuilder.from(Person).where((p) => p.name.equals('Semmy')).count(target as never),
    ).resolves.toBe(11);
  });

  test('await on the CountBuilder executes it', async () => {
    // The PromiseLike path uses the global dispatch, which the capture store sets
    // to answer 0.
    await expect(SelectBuilder.from(Person).toCount()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

describe('mapSparqlCountResult', () => {
  const ir = lower(SelectBuilder.from(Person).toCount()) as IRCountQuery;
  const bindings = (value: string) => ({
    head: {vars: ['count']},
    results: {bindings: [{count: {type: 'literal' as const, value}}]},
  });

  test('reads the bound number', () => {
    expect(mapSparqlCountResult(bindings('17'), ir)).toBe(17);
  });

  test('a genuine zero is returned', () => {
    expect(mapSparqlCountResult(bindings('0'), ir)).toBe(0);
  });

  test('an empty result set throws rather than reading as 0', () => {
    expect(() =>
      mapSparqlCountResult({head: {vars: ['count']}, results: {bindings: []}}, ir),
    ).toThrow(/no binding for \?count/);
  });

  test('a non-numeric binding throws rather than reading as 0', () => {
    expect(() => mapSparqlCountResult(bindings('lots'), ir)).toThrow(/not a number/);
  });

  test('an ASK response throws', () => {
    expect(() => mapSparqlCountResult({head: {}, boolean: true}, ir)).toThrow(
      /SELECT result set/,
    );
  });
});
