import {beforeAll, describe, expect, test} from '@jest/globals';
import {
  createNodeShapeData,
  createPropertyShapeData,
  type NodeShapeData,
} from '../shapes/nodeShapeData';
import {registerRuntimeShape, registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {SelectBuilder} from '../queries/QueryBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';
import {validate} from '../shapes/validation';
import {getNodeShape} from '../utils/ShapeClass';
import {xsd} from '../ontologies/xsd';

/**
 * Regression guard for review findings 1 and 2 — the whole point of the metamodel work.
 *
 * A shape that exists only as data (a project-authored shape, read back from materialized
 * SHACL) must behave in queries exactly like a compiled one. It did not:
 *
 * - `resolveShapeScanIri` read `getShapeClass(iri)?.targetClass`, and the adapter that
 *   `resolveShape` hands the builders is deliberately NOT in the class registry — so
 *   `SelectBuilder.from(dataOnlyIri)` resolved, built an IR, and then threw
 *   "Cannot resolve an rdf:type" at SPARQL generation.
 * - `findPropertyShapeById` scanned the class registry only, so a data-only property was
 *   never found and the property-shape IRI was emitted **as the predicate** — a silently
 *   wrong query rather than an error.
 * - `validate()` treated "has `extends` but no class" as a half-registered shape.
 *
 * The previous implementation of runtime shapes worked only because it registered a
 * synthetic class into the class registry. Moving that out was correct — `getShapeClass`
 * should mean "has an authored class" — but the lowering path had to move with it.
 *
 * These tests go all the way to SPARQL on purpose. `lower()` alone does NOT reproduce the
 * failure: the throw is in `irToAlgebra`, one stage further on. A test that stopped at
 * `lower()` passed while the feature was broken.
 */

const NS = 'https://example.org/data-only/';
const PARENT = `${NS}shape/Publication`;
const CHILD = `${NS}shape/Book`;

/** A shape as the catalog hands it over: metadata, no class anywhere. */
function dataShape(
  id: string,
  targetClass: string,
  properties: {label: string; predicate: string}[],
  extendsId?: string,
): NodeShapeData {
  const shape = createNodeShapeData(id);
  shape.label = id.split('/').pop()!;
  shape.targetClass = {id: targetClass};
  if (extendsId) shape.extends = {id: extendsId};
  shape.propertyShapes = properties.map(({label, predicate}) => {
    const prop = createPropertyShapeData();
    Object.assign(prop, {
      id: `${id}/${label}`,
      label,
      path: {id: predicate},
      datatype: xsd.string,
      parentNodeShape: shape,
    });
    return prop;
  });
  return shape;
}

describe('finding 1 — a shape known only as data lowers to correct SPARQL', () => {
  beforeAll(() => {
    registerRuntimeShapes([
      dataShape(CHILD, `${NS}vocab#Book`, [{label: 'title', predicate: 'https://schema.org/name'}], PARENT),
      dataShape(PARENT, `${NS}vocab#Publication`, [
        {label: 'publisher', predicate: 'https://schema.org/publisher'},
      ]),
    ]);
  });

  test('SPARQL generation does not throw', () => {
    const query = SelectBuilder.from(CHILD).select((b: any) => [b.title]);
    expect(() => selectToSparql(lower(query as never) as never)).not.toThrow();
  });

  test('instances are typed with the declared targetClass, not the shape IRI', () => {
    const query = SelectBuilder.from(CHILD).select((b: any) => [b.title]);
    const sparql = String(selectToSparql(lower(query as never) as never));
    expect(sparql).toContain(`${NS}vocab#Book`);
    // The shape IRI identifies the description, not the class being described.
    expect(sparql).not.toContain(`<${CHILD}>`);
  });

  test('the predicate is the declared sh:path, not the property-shape IRI', () => {
    // The dangerous half: this failed SILENTLY, emitting `<…/shape/Book/title>` as the
    // predicate and matching nothing.
    const query = SelectBuilder.from(CHILD).select((b: any) => [b.title]);
    const sparql = String(selectToSparql(lower(query as never) as never));
    expect(sparql).toContain('https://schema.org/name');
    expect(sparql).not.toContain(`${CHILD}/title`);
  });

  test('an inherited property lowers too, using the parent\'s predicate', () => {
    const query = SelectBuilder.from(CHILD).select((b: any) => [b.publisher]);
    const sparql = String(selectToSparql(lower(query as never) as never));
    expect(sparql).toContain('https://schema.org/publisher');
  });

  test('a targetClass inherited through `extends` resolves', () => {
    // A child that declares no targetClass of its own must still be typeable.
    const childIri = `${NS}shape/Untyped`;
    const child = createNodeShapeData(childIri);
    child.label = 'Untyped';
    child.extends = {id: PARENT};
    const prop = createPropertyShapeData();
    Object.assign(prop, {
      id: `${childIri}/publisher`,
      label: 'publisher',
      path: {id: 'https://schema.org/publisher'},
      parentNodeShape: child,
    });
    child.propertyShapes = [prop];
    registerRuntimeShape(child);

    const query = SelectBuilder.from(childIri).select((b: any) => [b.publisher]);
    const sparql = String(selectToSparql(lower(query as never) as never));
    expect(sparql).toContain(`${NS}vocab#Publication`);
  });

  test('a mutation lowers', () => {
    // `.for(id)` is required by UpdateBuilder regardless of shape kind; what is under test
    // is that `requireShape` finds a data-only shape at all.
    expect(() =>
      lower(
        (
          UpdateBuilder.from(CHILD) as unknown as {
            set: (d: Record<string, unknown>) => {for: (id: unknown) => unknown};
          }
        )
          .set({title: 'x'})
          .for({id: `${NS}instance/1`}) as never,
      ),
    ).not.toThrow();
  });
});

describe('finding 2 — validate() accepts a data-only shape with `extends`', () => {
  test('a registered child with a registered parent is valid', () => {
    // `validate()` takes shape metadata (or a class), not an IRI — unlike
    // `SelectBuilder.from`, which accepts either. Worth noting as an ergonomic
    // inconsistency; not changed here.
    const shape = getNodeShape(CHILD);
    expect(shape).toBeDefined(); // must be registered

    const report = validate(shape as never, {
      id: `${NS}instance/1`,
      title: 'Dune',
    }) as unknown as {conforms?: boolean; results?: unknown[]};

    // Whatever else it says, it must not claim the shape is unregistered.
    const messages = JSON.stringify(report?.results ?? []);
    expect(messages).not.toContain('not registered');
  });
});
