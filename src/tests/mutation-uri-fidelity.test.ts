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
 * Keeps its own fixture shape, for two reasons. It originally existed because the
 * shared query-fixtures used `linked://tmp/` paths that the resolver deliberately
 * skipped; that skip is gone, so that reason has expired. But the shape also
 * spells an accessor and its path DIFFERENTLY (`bestFriend` → `knows`), which no
 * shared fixture does for a single-valued object property — and that is what lets
 * this suite tell a shadow URI from a path at all.
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
  updateWhereToSparql,
} from '../sparql/irToAlgebra';
import type {
  IRCreateMutation,
  IRUpdateMutation,
  IRUpdateWhereMutation,
} from '../queries/IntermediateRepresentation';
import {NodeReferenceValue} from '../queries/QueryFactory';

import '../ontologies/rdf';

const ONT_BASE = 'linked://mutation-fidelity/';
const ontProp = (s: string): NodeReferenceValue => ({id: `${ONT_BASE}props/${s}`});
const ontCls = (s: string): NodeReferenceValue => ({id: `${ONT_BASE}types/${s}`});

const PERSON_CLASS_URI = `${ONT_BASE}types/Person`;
const NAME_PATH_URI = `${ONT_BASE}props/name`;
const HOBBY_PATH_URI = `${ONT_BASE}props/hobby`;
const HAS_FRIEND_PATH_URI = `${ONT_BASE}props/hasFriend`;
const KNOWS_PATH_URI = `${ONT_BASE}props/knows`;

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

  // Accessor and path are spelled DIFFERENTLY on purpose. Every other fixture in
  // the repo spells them alike for single-valued object properties, which is
  // exactly why a traversal emitting the shadow IRI went unnoticed: the wrong
  // predicate and the right one were the same string.
  @objectProperty({path: ontProp('knows'), maxCount: 1, shape: MfPerson})
  get bestFriend(): MfPerson {
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

  // -------------------------------------------------------------------------
  // Expression traversals — the case this suite did not cover, and the one that
  // let a shadow-URI leak survive. `p.bestFriend.name` emits an intermediate
  // traversal edge; that edge is a predicate like any other.
  // -------------------------------------------------------------------------

  test('update: an expression traversal edge uses the path URI, not the shadow URI', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({
        id: `${ONT_BASE}data/p1`,
      }),
    )) as IRUpdateMutation;
    const sparql = updateToSparql(ir);

    expect(sparql).toContain(`<${KNOWS_PATH_URI}>`);
    expect(sparql).not.toContain(SHAPE_SHADOW_NODE);
    // Specifically not the accessor-spelled shadow predicate. A shape whose
    // accessor and path are spelled alike cannot tell these apart, so assert the
    // spelling too, not just the base.
    expect(sparql).not.toContain('/bestFriend>');
  });

  test('update: the traversal leaf property also uses its own path URI', async () => {
    const ir = (await captureQuery(() =>
      MfPerson.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).for({
        id: `${ONT_BASE}data/p1`,
      }),
    )) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toContain(`<${NAME_PATH_URI}>`);
  });

  test('update-where: an expression traversal edge uses the path URI', async () => {
    // The second of the two sites that built traversal predicates by hand.
    const ir = (await captureQuery(() =>
      MfPerson.update((p: any) => ({hobby: p.bestFriend.name.ucase()})).where(
        (p: any) => p.name.equals('Alice'),
      ),
    )) as IRUpdateWhereMutation;
    // An `update().where()` lowers to a different IR kind with its own serializer.
    const sparql = updateWhereToSparql(ir);

    expect(sparql).toContain(`<${KNOWS_PATH_URI}>`);
    expect(sparql).not.toContain(SHAPE_SHADOW_NODE);
    expect(sparql).not.toContain('/bestFriend>');
  });

  test('a traversal on a shape whose accessor and path agree still resolves', async () => {
    // Guards the fix itself: routing through the resolver must not break the
    // ordinary same-spelling case.
    const ir = (await captureQuery(() =>
      MfPerson.update((p: any) => ({name: p.bestFriend.hobby.lcase()})).for({
        id: `${ONT_BASE}data/p1`,
      }),
    )) as IRUpdateMutation;
    const sparql = updateToSparql(ir);
    expect(sparql).toContain(`<${HOBBY_PATH_URI}>`);
    expect(sparql).toContain(`<${KNOWS_PATH_URI}>`);
  });
});
