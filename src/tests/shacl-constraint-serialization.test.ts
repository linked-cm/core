/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * G5 (report 021 §3) — SHACL value-range / string-length / pattern constraints are
 * recorded on the PropertyShape and serialized to SHACL. There is NO DSL-side runtime
 * enforcement: these describe the shape for validators / introspection only.
 */
import {describe, expect, test} from '@jest/globals';
import {getPropertyShape, propertyShapeToResult} from '../shapes/SHACL';
import '../utils/Package'; // runs the core meta-model setup (adds the constraint accessors)
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {NodeShape, literalProperty} from '../shapes/SHACL';
import {createToSparql} from '../sparql/irToAlgebra';
import {lower} from '../queries/lower';
import {xsd} from '../ontologies/xsd';

const {linkedShape} = linkedPackage('g5-test');

const prop = (name: string) => ({id: `https://example.org/g5#${name}`});

@linkedShape
class Measurement extends Shape {
  @literalProperty({
    path: prop('score'),
    datatype: xsd.integer,
    maxCount: 1,
    minInclusive: 0,
    maxInclusive: 100,
  })
  get score(): number {
    return 0;
  }

  @literalProperty({
    path: prop('ratio'),
    datatype: xsd.double,
    maxCount: 1,
    minExclusive: 0,
    maxExclusive: 1,
  })
  get ratio(): number {
    return 0;
  }

  @literalProperty({
    path: prop('code'),
    datatype: xsd.string,
    maxCount: 1,
    minLength: 3,
    maxLength: 8,
    pattern: /^[A-Z]+$/,
  })
  get code(): string {
    return '';
  }
}

describe('G5 — SHACL constraint serialization', () => {
  test('createPropertyShape records the constraints on the PropertyShape', () => {
    const score = getPropertyShape(Measurement.shape, 'score', false);
    expect(score.minInclusive).toBe(0);
    expect(score.maxInclusive).toBe(100);

    const ratio = getPropertyShape(Measurement.shape, 'ratio', false);
    expect(ratio.minExclusive).toBe(0);
    expect(ratio.maxExclusive).toBe(1);

    const code = getPropertyShape(Measurement.shape, 'code', false);
    expect(code.minLength).toBe(3);
    expect(code.maxLength).toBe(8);
    expect(code.pattern).toBeInstanceOf(RegExp);
    expect(code.pattern?.source).toBe('^[A-Z]+$');
  });

  test('getResult() exposes the constraints (pattern as its source string)', () => {
    const code: any = propertyShapeToResult(getPropertyShape(Measurement.shape, 'code', false));
    expect(code.minLength).toBe(3);
    expect(code.maxLength).toBe(8);
    expect(code.pattern).toBe('^[A-Z]+$'); // regex source, not a RegExp
    const ratio: any = propertyShapeToResult(getPropertyShape(Measurement.shape, 'ratio', false));
    expect(ratio.minExclusive).toBe(0);
    expect(ratio.maxExclusive).toBe(1);
  });

  test('meta-model resolves the constraint labels to sh: predicates in serialized SHACL', () => {
    const shapeIri = 'https://example.org/shape/Measurement';
    const ir = lower(
      (NodeShape.create({
        targetClass: {id: 'https://example.org/Measurement'},
        properties: [
          {
            __id: `${shapeIri}/score`,
            path: prop('score'),
            datatype: xsd.integer,
            minInclusive: 0,
            maxInclusive: 100,
          },
          {
            __id: `${shapeIri}/code`,
            path: prop('code'),
            datatype: xsd.string,
            minLength: 3,
            maxLength: 8,
            pattern: '^[A-Z]+$',
          },
        ],
      } as any) as any).withId(shapeIri) as any,
    ) as any;
    const sparql = createToSparql(ir);

    expect(sparql).toContain('shacl:minInclusive "0"^^xsd:integer');
    expect(sparql).toContain('shacl:maxInclusive "100"^^xsd:integer');
    expect(sparql).toContain('shacl:minLength "3"^^xsd:integer');
    expect(sparql).toContain('shacl:maxLength "8"^^xsd:integer');
    expect(sparql).toContain('shacl:pattern "^[A-Z]+$"');
  });
});
