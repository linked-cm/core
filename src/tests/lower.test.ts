import {describe, expect, test} from '@jest/globals';
import {Person, queryFactories} from '../test-helpers/query-fixtures';
import {sanitize} from '../test-helpers/test-utils';
import {QueryBuilder} from '../queries/QueryBuilder';
import {lower} from '../queries/lower';

/**
 * The free `lower()` function replaces the (now deprecated) builder `.build()`.
 * It must produce identical IR, across select and every mutation kind.
 */
describe('lower()', () => {
  test('select — lower equals deprecated build', () => {
    const qb = QueryBuilder.from(Person)
      .select(['name'])
      .where((p: any) => p.name.equals('Semmy'))
      .limit(20);
    expect(sanitize(lower(qb as any))).toEqual(sanitize(qb.build()));
    expect((lower(qb as any) as any).kind).toBe('select');
  });

  test('mutations — lower equals deprecated build', () => {
    const create = queryFactories.createSimple();
    const update = queryFactories.updateAddRemoveMulti();
    const del = queryFactories.deleteMultiple();
    expect(sanitize(lower(create))).toEqual(sanitize(create.build()));
    expect(sanitize(lower(update))).toEqual(sanitize(update.build()));
    expect(sanitize(lower(del))).toEqual(sanitize(del.build()));
    expect((lower(create) as any).kind).toBe('create');
    expect((lower(del) as any).kind).toBe('delete');
  });
});
