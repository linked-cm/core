/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {xsd} from '../ontologies/xsd';

const {linkedShape} = linkedPackage('shape-guard-test');
const ex = (n: string) => ({id: `https://example.org/guard#${n}`});

@linkedShape
class GuardPerson extends Shape {
  static targetClass = ex('Person');
  @literalProperty({path: ex('name'), maxCount: 1, datatype: xsd.string})
  get name(): string {
    return '';
  }
}

describe('Shape instantiation guard', () => {
  test('`new` on a domain shape throws and steers to the DSL', () => {
    expect(() => new (GuardPerson as any)()).toThrow(
      /Cannot instantiate shape `GuardPerson` directly/,
    );
    expect(() => new (GuardPerson as any)()).toThrow(/Use the DSL/);
  });

  test('`new Shape()` (base) throws', () => {
    expect(() => new (Shape as any)()).toThrow(/shapes are metadata, not data/);
  });

  test('the DSL still works without instantiating the shape', () => {
    // Building a query/mutation must not construct the shape.
    expect(() => GuardPerson.select((p) => p.name)).not.toThrow();
    expect(() => GuardPerson.create({name: 'Ada'})).not.toThrow();
    // The static metadata is a plain object (not a class instance).
    expect(Object.getPrototypeOf(GuardPerson.shape)).toBe(Object.prototype);
    expect(GuardPerson.shape.label).toBe('GuardPerson');
  });
});
