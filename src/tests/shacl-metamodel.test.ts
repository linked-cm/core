/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import '../utils/Package'; // runs the core meta-model setup (sets NodeShape.shape etc.)
import {NodeShape, PropertyShape} from '../shapes/SHACL';
import {createToSparql} from '../sparql/irToAlgebra';
import {xsd} from '../ontologies/xsd';
import '../ontologies/rdf';
import '../ontologies/shacl';

describe('plan-001 P5 — meta-model serialization', () => {
  test('NodeShape.create serializes node + property + constraints', () => {
    const shapeIri = 'https://example.org/shape/Person';
    const ir = (NodeShape.create({
      targetClass: {id: 'https://example.org/Person'},
      properties: [
        {
          __id: `${shapeIri}/name`,
          path: {id: 'https://example.org/name'},
          minCount: 1,
          maxCount: 1,
          datatype: xsd.string,
          name: 'Name',
        },
      ],
    } as any) as any)
      .withId(shapeIri)
      .build();
    const sparql = createToSparql(ir);

    expect(sparql).toContain(`<${shapeIri}> rdf:type shacl:NodeShape`);
    expect(sparql).toContain('shacl:targetClass <https://example.org/Person>');
    expect(sparql).toContain(`<${shapeIri}> shacl:property <${shapeIri}/name>`);
    expect(sparql).toContain(`<${shapeIri}/name> rdf:type shacl:PropertyShape`);
    expect(sparql).toContain('shacl:path <https://example.org/name>');
    expect(sparql).toContain('shacl:minCount "1"^^xsd:integer');
    expect(sparql).toContain('shacl:maxCount "1"^^xsd:integer');
    expect(sparql).toContain('shacl:datatype xsd:string');
    expect(sparql).toContain('shacl:name "Name"');
  });

  test('meta-model marks contains on properties/path/in; PropertyShape dependent', () => {
    expect(NodeShape.shape.getPropertyShape('properties', false).contains).toBe(true);
    expect(PropertyShape.shape.getPropertyShape('path', false).contains).toBe(true);
    expect(PropertyShape.shape.getPropertyShape('in', false).contains).toBe(true);
    expect(PropertyShape.shape.dependent).toBe(true);
  });
});
