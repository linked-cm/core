/**
 * Phase 6 — `and`/`or`/`not` are reserved as property labels (they are DSL-JSON
 * where-clause combinators with no key-position `{path}` escape).
 */
import {describe, expect, test} from '@jest/globals';
import {registerPropertyShape} from '../shapes/SHACL';

describe('reserved property labels', () => {
  for (const label of ['and', 'or', 'not']) {
    test(`registering a property named '${label}' throws`, () => {
      expect(() =>
        registerPropertyShape({} as any, {label} as any),
      ).toThrow(/reserved/);
    });
  }

  test('a non-reserved label passes the reserved-label guard', () => {
    // `name` is not reserved, so it proceeds past the guard (and then fails on
    // the bare stub for an unrelated reason — never the reserved error).
    expect(() =>
      registerPropertyShape({} as any, {label: 'name'} as any),
    ).not.toThrow(/reserved/);
  });
});
