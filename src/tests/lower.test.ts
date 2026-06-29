import {describe, expect, test} from '@jest/globals';
import {Person, queryFactories} from '../test-helpers/query-fixtures';
import {sanitize} from '../test-helpers/test-utils';
import {QueryBuilder} from '../queries/QueryBuilder';
import {buildSelectQuery} from '../queries/IRPipeline';
import {lower} from '../queries/lower';

/**
 * The free `lower()` function is the single entry point that turns any live
 * query (the builder, upcast to its closed `*Query` interface) into canonical
 * IR. It replaces the old per-builder `.build()` method.
 */
describe('lower()', () => {
  test('select — lowers to canonical IR via the raw input', () => {
    const qb = QueryBuilder.from(Person)
      .select(['name'])
      .where((p: any) => p.name.equals('Semmy'))
      .limit(20);
    // lower(select) must equal building straight from the raw select input.
    expect(sanitize(lower(qb))).toEqual(sanitize(buildSelectQuery(qb.toRawInput())));
    expect((lower(qb) as any).kind).toBe('select');
  });

  test('mutations — lower equals the builder _toIR', () => {
    const create = queryFactories.createSimple();
    const update = queryFactories.updateAddRemoveMulti();
    const del = queryFactories.deleteMultiple();
    expect(sanitize(lower(create))).toEqual(sanitize((create as any)._toIR()));
    expect(sanitize(lower(update))).toEqual(sanitize((update as any)._toIR()));
    expect(sanitize(lower(del))).toEqual(sanitize((del as any)._toIR()));
    expect((lower(create) as any).kind).toBe('create');
    expect((lower(del) as any).kind).toBe('delete');
  });
});
