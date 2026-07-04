/**
 * Lightweight structural validation of mutation values against the PropertyShape:
 * cardinality (min/maxCount) and node-kind (literal vs relation). Fails fast when
 * the mutation is normalized (`.toJSON()` / lower / exec) rather than surfacing a
 * confusing store error later. Structural only — it does not duplicate the
 * datatype/deep validation the store performs.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {Person} from '../test-helpers/query-fixtures';

const base = 'linked://tmp/val/';
const prop = (s: string): NodeReferenceValue => ({id: `${base}props/${s}`});

@linkedShape
class Team extends Shape {
  static targetClass = {id: `${base}types/Team`} as any;

  // A property that requires at least two values.
  @literalProperty({path: prop('members'), minCount: 2})
  get members(): string[] {
    return [];
  }
}

describe('mutation value validation — cardinality', () => {
  test('maxCount: a single-valued property given an array throws', () => {
    expect(() => Person.create({name: ['a', 'b']} as any).toJSON()).toThrow(/at most 1 value/);
  });

  test('maxCount is enforced on update too, not just create', () => {
    expect(() =>
      Person.update({name: ['a', 'b']} as any).for({id: 'x:p1'}).toJSON(),
    ).toThrow(/at most 1 value/);
  });

  test('maxCount: within the limit is accepted', () => {
    expect(() => Person.create({name: 'Alice'} as any).toJSON()).not.toThrow();
  });

  test('minCount: fewer values than required throws', () => {
    expect(() => Team.create({members: ['only-one']} as any).toJSON()).toThrow(
      /at least 2 value/,
    );
  });

  test('minCount: meeting the floor is accepted', () => {
    expect(() => Team.create({members: ['a', 'b']} as any).toJSON()).not.toThrow();
  });
});

describe('mutation value validation — node kind', () => {
  test('a literal property given a node reference {id} throws', () => {
    expect(() => Person.create({name: {id: 'x:1'}} as any).toJSON()).toThrow(
      /literal property/,
    );
  });

  test('a relation property given a bare scalar throws', () => {
    expect(() => Person.create({bestFriend: 'not-a-node'} as any).toJSON()).toThrow(
      /relation \(object\) property/,
    );
  });

  test('a relation property given a {id} reference is accepted', () => {
    expect(() =>
      Person.create({name: 'Alice', bestFriend: {id: 'x:2'}} as any).toJSON(),
    ).not.toThrow();
  });

  test('a relation property given a nested object (create) is accepted', () => {
    expect(() =>
      Person.create({name: 'Alice', bestFriend: {name: 'Bestie'}} as any).toJSON(),
    ).not.toThrow();
  });

  test('set-modifications are exempt (final count/kind not known here)', () => {
    expect(() =>
      Person.update({friends: {add: [{id: 'x:3'}], remove: [{id: 'x:p2'}]}} as any)
        .for({id: 'x:p1'})
        .toJSON(),
    ).not.toThrow();
  });
});
