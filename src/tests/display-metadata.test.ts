import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {
  createNodeShapeData,
  createPropertyShapeData,
  getPropertyShapes,
} from '../shapes/nodeShapeData';
import {
  getSuperShapes,
  isSubShapeOf,
  registerNodeShape,
} from '../utils/ShapeClass';
import {toWire} from '../shapes/nodeShapeWire';
import {coreOntology} from '../ontologies/linked-core';
import {xsd} from '../ontologies/xsd';

const {linkedShape} = linkedPackage('display-metadata-test');
const ns = (local: string) => ({id: `https://example.org/dm/${local}`});

@linkedShape
class Article extends Shape {
  static targetClass = ns('Article');

  @literalProperty({
    path: ns('title'),
    datatype: xsd.string,
    required: true,
    displayRank: 1,
    order: 10,
    group: 'basics',
  })
  get title(): string {
    return '';
  }

  @literalProperty({
    path: ns('summary'),
    datatype: xsd.string,
    displayRank: 2,
  })
  get summary(): string {
    return '';
  }

  @literalProperty({
    path: ns('internalNote'),
    datatype: xsd.string,
    displayHidden: true,
  })
  get internalNote(): string {
    return '';
  }

  @literalProperty({path: ns('wordCount'), datatype: xsd.integer})
  get wordCount(): number {
    return 0;
  }
}

const propByLabel = (label: string) => {
  const prop = getPropertyShapes(Article.shape).find((p) => p.label === label);
  if (!prop) throw new Error(`no property shape for ${label}`);
  return prop;
};

describe('display metadata — decorator to shape', () => {
  test('displayRank is carried onto the property shape', () => {
    expect(propByLabel('title').displayRank).toBe(1);
    expect(propByLabel('summary').displayRank).toBe(2);
    expect(propByLabel('wordCount').displayRank).toBeUndefined();
  });

  test('displayHidden is carried onto the property shape', () => {
    expect(propByLabel('internalNote').displayHidden).toBe(true);
    expect(propByLabel('title').displayHidden).toBeUndefined();
  });

  test('sh:order and sh:group are carried — previously declared but dropped', () => {
    // Regression: `order` and `group` were declared on PropertyShapeConfig but never
    // copied in createPropertyShape, so a declared sh:order never reached the shape
    // and every renderer silently fell back to array position.
    expect(propByLabel('title').order).toBe(10);
    expect(propByLabel('title').group).toBe('basics');
  });

  test('the terms live in the linked-core ecosystem namespace, not the CN code vocab', () => {
    expect(coreOntology.displayRank.id).toBe(
      'https://linked.cm/ont/linked-core/displayRank',
    );
    expect(coreOntology.displayHidden.id).toBe(
      'https://linked.cm/ont/linked-core/displayHidden',
    );
  });
});

describe('display metadata — over the wire', () => {
  test('survives a JSON hop', () => {
    const wire = JSON.parse(JSON.stringify(toWire(Article.shape)));
    const byLabel = (label: string) =>
      wire.propertyShapes.find((p: {label: string}) => p.label === label);
    expect(byLabel('title').displayRank).toBe(1);
    expect(byLabel('title').order).toBe(10);
    expect(byLabel('title').group).toBe('basics');
    expect(byLabel('internalNote').displayHidden).toBe(true);
  });

  test('ranking a shape by declared rank puts the ranked properties first', () => {
    const props = toWire(Article.shape).propertyShapes;
    const ranked = props
      .filter((p) => p.displayRank !== undefined)
      .sort((a, b) => a.displayRank! - b.displayRank!)
      .map((p) => p.label);
    expect(ranked).toEqual(['title', 'summary']);
  });
});

describe('inheritance for a shape that exists only as data', () => {
  test('a registered child inherits its parent\'s properties via `extends`', () => {
    // Before the walks were unified, getPropertyShapes(shape, true) returned ONLY own
    // properties when the shape had no class — so a project-authored shape silently
    // lost everything it inherited. This is the regression guard for that.
    const parentIri = 'https://example.org/dm/data/Parent';
    const childIri = 'https://example.org/dm/data/Child';

    const parent = createNodeShapeData(parentIri);
    parent.label = 'Parent';
    const inherited = createPropertyShapeData();
    Object.assign(inherited, {
      id: `${parentIri}/inheritedField`,
      label: 'inheritedField',
      path: ns('inheritedField'),
    });
    parent.propertyShapes = [inherited];

    const child = createNodeShapeData(childIri);
    child.label = 'Child';
    child.extends = {id: parentIri};
    const own = createPropertyShapeData();
    Object.assign(own, {
      id: `${childIri}/ownField`,
      label: 'ownField',
      path: ns('ownField'),
    });
    child.propertyShapes = [own];

    registerNodeShape(parent);
    registerNodeShape(child);

    expect(getSuperShapes(child).map((s) => s.id)).toEqual([parentIri]);
    expect(isSubShapeOf(childIri, parentIri)).toBe(true);
    expect(isSubShapeOf(parentIri, childIri)).toBe(false);

    const labels = getPropertyShapes(child, true).map((p) => p.label);
    expect(labels).toContain('ownField');
    expect(labels).toContain('inheritedField');
  });

  test('an unresolvable `extends` ends the walk instead of throwing', () => {
    const orphanIri = 'https://example.org/dm/data/Orphan';
    const orphan = createNodeShapeData(orphanIri);
    orphan.label = 'Orphan';
    orphan.extends = {id: 'https://example.org/dm/data/NeverRegistered'};
    registerNodeShape(orphan);
    expect(() => getSuperShapes(orphan)).not.toThrow();
    expect(getSuperShapes(orphan)).toEqual([]);
  });

  test('a cycle in `extends` terminates', () => {
    const aIri = 'https://example.org/dm/data/CycleA';
    const bIri = 'https://example.org/dm/data/CycleB';
    const a = createNodeShapeData(aIri);
    a.extends = {id: bIri};
    const b = createNodeShapeData(bIri);
    b.extends = {id: aIri};
    registerNodeShape(a);
    registerNodeShape(b);
    expect(() => getSuperShapes(a)).not.toThrow();
    expect(getSuperShapes(a).map((s) => s.id)).toEqual([bIri]);
  });
});
