/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * The meta-model-derived constraint table used by alternative SHACL serializers
 * (see `shapes/propertyShapeTerms.ts`).
 */
import {describe, expect, test} from '@jest/globals';
import '../utils/Package'; // runs the core meta-model setup (registers the constraint accessors)
import {getPropertyShapeTerm, getPropertyShapeTerms} from '../shapes/propertyShapeTerms';

const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

describe('propertyShapeTerms', () => {
  test('exposes the constraints the meta-model registers, with their sh: predicate', () => {
    const terms = getPropertyShapeTerms();
    for (const label of [
      'path', 'nodeKind', 'datatype', 'minCount', 'maxCount', 'name', 'description',
      'class', 'in', 'disjoint', 'lessThan', 'lessThanOrEquals', 'hasValue',
      'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive',
      'minLength', 'maxLength', 'pattern', 'order', 'group',
    ]) {
      expect(terms.get(label)?.predicate).toBe(`${SH}${label}`);
    }
  });

  test('carries the pinned literal datatype where the meta-model declares one', () => {
    expect(getPropertyShapeTerm('minLength')?.datatype).toBe(`${XSD}integer`);
    expect(getPropertyShapeTerm('maxLength')?.datatype).toBe(`${XSD}integer`);
    expect(getPropertyShapeTerm('pattern')?.datatype).toBe(`${XSD}string`);
    expect(getPropertyShapeTerm('order')?.datatype).toBe(`${XSD}integer`);
    // Range constraints are deliberately untyped — the literal is typed from the value.
    expect(getPropertyShapeTerm('minInclusive')?.datatype).toBeUndefined();
    expect(getPropertyShapeTerm('maxExclusive')?.datatype).toBeUndefined();
  });

  test('carries the node kind, so IRI-valued constraints are distinguishable from literals', () => {
    expect(getPropertyShapeTerm('class')?.nodeKind).toBe(`${SH}IRI`);
    expect(getPropertyShapeTerm('datatype')?.nodeKind).toBe(`${SH}IRI`);
    expect(getPropertyShapeTerm('pattern')?.nodeKind).toBe(`${SH}Literal`);
    // sh:hasValue accepts either — the meta-model pins no node kind.
    expect(getPropertyShapeTerm('hasValue')?.nodeKind).toBeUndefined();
  });

  test('valueShape maps to sh:node, and unknown labels are undefined', () => {
    expect(getPropertyShapeTerm('valueShape')?.predicate).toBe(`${SH}node`);
    // sh:equals is labelled `equalsConstraint` — `equals` is a query-builder method.
    expect(getPropertyShapeTerm('equalsConstraint')?.predicate).toBe(`${SH}equals`);
    expect(getPropertyShapeTerm('equals')).toBeUndefined();
    expect(getPropertyShapeTerm('notAConstraint')).toBeUndefined();
  });
});
