/**
 * Mutation URI fidelity test.
 *
 * Verifies that DSL `Shape.create()` / `Shape.update()` emit SPARQL using the
 * URIs declared on the shape decorators — `targetClass` for `rdf:type`,
 * and the property's `path` URI for each predicate — NOT the synthesized
 * SHACL NodeShape / PropertyShape URIs.
 *
 * Background: a previous fix (SELECT-side) resolved shape-shadow URIs at
 * SPARQL emission time via resolveShapeScanIri / resolvePropertyPredicateIri,
 * but the mutation paths (CREATE / UPDATE / DELETE / *_where) were not
 * covered. This test pins the corrected behavior across all mutation kinds:
 * the decorator's `path` is authoritative for the predicate written, and
 * `targetClass` is authoritative for `rdf:type`.
 *
 * Uses its own fixture shape with a non-`linked://tmp/` URI base, because the
 * shared query-fixtures shape uses `linked://tmp/` which is intentionally
 * skipped by the resolver (existing golden-SELECT tests rely on raw shape ids).
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {ShapeSet} from '../collections/ShapeSet';
import {captureQuery} from '../test-helpers/query-capture-store';
import {
  createToSparql,
  updateToSparql,
} from '../sparql/irToAlgebra';
import type {
  IRCreateMutation,
  IRUpdateMutation,
} from '../queries/IntermediateRepresentation';
import {NodeReferenceValue} from '../queries/QueryFactory';

import '../ontologies/rdf';

// Use a non-`linked://tmp/` base so the resolver actually resolves URIs.
const ONT_BASE = 'linked://mutation-fidelity/';
const ontProp = (s: string): NodeReferenceValue => ({id: `${ONT_BASE}props/${s}`});
const ontCls = (s: string): NodeReferenceValue => ({id: `${ONT_BASE}types/${s}`});

const PERSON_CLASS_URI = `${ONT_BASE}types/Person`;
const NAME_PATH_URI = `${ONT_BASE}props/name`;
const HOBBY_PATH_URI = `${ONT_BASE}props/hobby`;
const HAS_FRIEND_PATH_URI = `${ONT_BASE}props/hasFriend`;

// Shape-shadow URIs that MUST NOT leak into emitted SPARQL once resolution is applied.
const SHAPE_SHADOW_NODE = 'https://linked.cm/shape/core/MfPerson';

@linkedShape
class MfPerson extends Shape {
  static targetClass = ontCls('Person');

  @literalProperty({path: ontProp('name'), maxCount: 1})
  get name(): string {
    return '';
  }

  @literalProperty({path: ontProp('hobby'), maxCount: 1})
  get hobby(): string {
    return '';
  }

  @objectProperty({path: ontProp('hasFriend'), shape: MfPerson})
  get friends(): ShapeSet<MfPerson> {
    return null;
  }
}

describe('Mutation URI fidelity — DSL writes use ontology paths, not shape-shadow URIs', () => {
  test('create: rdf:type uses Shape.targetClass URI, not the NodeShape id', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.create({name: 'Alice'}),
    )) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toContain(`rdf:type <${PERSON_CLASS_URI}>`);
    expect(sparql).not.toContain(`rdf:type <${SHAPE_SHADOW_NODE}>`);
  });

  test('create: literal-property predicate uses @literalProperty({path}), not shape-shadow URI', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.create({name: 'Alice'}),
    )) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toContain(`<${NAME_PATH_URI}> "Alice"`);
    expect(sparql).not.toContain(`<${SHAPE_SHADOW_NODE}/name>`);
  });

  test('create: multiple literal properties — each uses its own path URI', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.create({name: 'Alice', hobby: 'Chess'}),
    )) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toContain(`<${NAME_PATH_URI}> "Alice"`);
    expect(sparql).toContain(`<${HOBBY_PATH_URI}> "Chess"`);
    expect(sparql).not.toContain(`<${SHAPE_SHADOW_NODE}/hobby>`);
  });

  test('update: predicate uses path URI, not shape-shadow URI', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.update({name: 'Bob'}).for({id: 'https://my.app/alice'}),
    )) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    expect(sparql).toContain(`<${NAME_PATH_URI}>`);
    expect(sparql).not.toContain(`<${SHAPE_SHADOW_NODE}/name>`);
  });

  test('create: nested object property uses path URI for the link triple', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.create({
        name: 'Alice',
        friends: [{id: 'https://my.app/bob'}],
      }),
    )) as IRCreateMutation;
    const sparql = createToSparql(ir);

    expect(sparql).toContain(`<${HAS_FRIEND_PATH_URI}> <https://my.app/bob>`);
    expect(sparql).not.toContain(`<${SHAPE_SHADOW_NODE}/friends>`);
  });

  test('update: set-modification (add) uses path URI for the link triple', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.update({
        friends: {add: [{id: 'https://my.app/bob'}]},
      } as any).for({id: 'https://my.app/alice'}),
    )) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    expect(sparql).toContain(
      `<${HAS_FRIEND_PATH_URI}> <https://my.app/bob>`,
    );
    expect(sparql).not.toContain(`<${SHAPE_SHADOW_NODE}/friends>`);
  });
});
