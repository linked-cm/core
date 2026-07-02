/**
 * Path-keyed mutation node data (Z-c) — shape wire form and the `__shape`/`__id`
 * escape hatches, including the polymorphism case (a subclass instance nested
 * under a superclass-typed relation).
 */
import {describe, expect, test} from '@jest/globals';
import {Person, Employee} from '../test-helpers/query-fixtures';
import {MutationQueryFactory} from '../queries/MutationQuery';
import {encodeNodeData} from '../queries/MutationSerialization';
import {decodeNodeData} from '../queries/lowerMutationJSON';

const desc = (shape: any, data: any) =>
  new MutationQueryFactory().describe(shape, data);

describe('DSL-JSON mutation node data — path-keyed', () => {
  test('create data is path-keyed with no shape/fields scaffold', () => {
    const json: any = Person.create({name: 'Alice', hobby: 'Chess'}).toJSON();
    expect(json.data).toEqual({name: 'Alice', hobby: 'Chess'});
    expect(json.data.shape).toBeUndefined();
    expect(json.data.fields).toBeUndefined();
  });

  test('nested node is bare; a set relation uses {list}', () => {
    const json: any = Person.create({
      name: 'Alice',
      bestFriend: {name: 'Bestie'},
      friends: [{id: 'x:2'}],
    } as any).toJSON();
    expect(json.data.bestFriend).toEqual({name: 'Bestie'});
    expect(json.data.friends).toEqual({list: [{id: 'x:2'}]});
  });

  test('__id carries a fixed/predefined id', () => {
    const json: any = Person.create({__id: 'x:1', name: 'A'} as any).toJSON();
    expect(json.data.__id).toBe('x:1');
    expect(json.data.name).toBe('A');
  });

  test('__shape is emitted only for a subclass instance (polymorphism)', () => {
    // Same shape as expected → no __shape.
    const same = encodeNodeData(desc(Person.shape, {name: 'P'}), Person.shape);
    expect(same.__shape).toBeUndefined();

    // Employee under a Person-typed slot → concrete shape recorded.
    const poly = encodeNodeData(desc(Employee.shape, {name: 'E'}), Person.shape);
    expect(poly.__shape).toBe(Employee.shape.id);
  });

  test('__shape round-trips: decode recovers the concrete subclass', () => {
    const poly = encodeNodeData(desc(Employee.shape, {name: 'E'}), Person.shape);
    // Decoded against the *declared* (Person) shape, __shape overrides it back to Employee.
    const decoded = decodeNodeData(poly, Person.shape);
    expect(decoded.shape.id).toBe(Employee.shape.id);
  });
});
