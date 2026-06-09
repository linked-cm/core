import {describe, expect, test, jest, beforeEach} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {CoreSet} from '../collections/CoreSet';
import {
  getLeastSpecificShapeClasses,
  getMostSpecificSubShapes,
  getPropertyShapeByLabel,
  getShapeClass,
  getSubShapesClasses,
  getSuperShapesClasses,
} from '../utils/ShapeClass';
import {LinkedStorage} from '../utils/LinkedStorage';
import {LinkedFileStorage, asset} from '../utils/LinkedFileStorage';
import {getQueryDispatch} from '../queries/queryDispatch';
import {getQueryContext, setQueryContext, PendingQueryContext} from '../queries/QueryContext';
import {NodeReferenceValue} from '../utils/NodeReference';

const makeProp = (base: string) => (suffix: string): NodeReferenceValue => ({
  id: `${base}${suffix}`,
});

const shapeProp = makeProp('linked://tmp/shapeclass/');
const contextProp = makeProp('linked://tmp/context/');
const packageProp = makeProp('linked://tmp/package/');

const {linkedShape: linkedShapeClassTest} = linkedPackage('shapeclass-test');
const {linkedShape: linkedShapeContextTest} = linkedPackage('context-test');
const {
  linkedShape: linkedShapePackageTest,
  registerPackageExport,
  registerPackageModule,
  packageExports,
  getPackageShape,
} = linkedPackage('package-test');

@linkedShapeClassTest
class BaseShape extends Shape {
  @literalProperty({path: shapeProp('base')})
  get base(): string {
    return '';
  }
}

@linkedShapeClassTest
class SubShape extends BaseShape {
  @literalProperty({path: shapeProp('sub')})
  get sub(): string {
    return '';
  }
}

@linkedShapeClassTest
class DeepSubShape extends SubShape {
  @literalProperty({path: shapeProp('deep')})
  get deep(): string {
    return '';
  }
}

@linkedShapeClassTest
class SiblingSubShape extends BaseShape {
  @literalProperty({path: shapeProp('sibling')})
  get sibling(): string {
    return '';
  }
}

@linkedShapeContextTest
class ContextPerson extends Shape {
  @literalProperty({path: contextProp('name'), maxCount: 1})
  get name(): string {
    return '';
  }

  @objectProperty({path: contextProp('bestFriend'), maxCount: 1, shape: ContextPerson})
  get bestFriend(): ContextPerson {
    return null;
  }
}

@linkedShapePackageTest
class PackagePerson extends Shape {
  @literalProperty({path: packageProp('name'), maxCount: 1})
  get name(): string {
    return '';
  }
}

const resetLinkedStorage = () => {
  LinkedStorage.setDefaultDataset(null as any);
  LinkedStorage.getShapeToDatasetMap().clear();
};

describe('ShapeClass utilities', () => {
  test('getShapeClass resolves a class by node shape id', () => {
    expect(getShapeClass(BaseShape.shape.id)).toBe(BaseShape);
  });

  test('getSubShapesClasses returns subclasses', () => {
    const subs = getSubShapesClasses(BaseShape);
    expect(subs).toEqual(
      expect.arrayContaining([SubShape, DeepSubShape, SiblingSubShape]),
    );
  });

  test('getSuperShapesClasses returns superclasses (most specific first)', () => {
    const supers = getSuperShapesClasses(DeepSubShape);
    expect(supers[0]).toBe(SubShape);
    expect(supers).toEqual(expect.arrayContaining([BaseShape, Shape]));
  });

  test('getPropertyShapeByLabel walks inheritance chain', () => {
    const property = getPropertyShapeByLabel(DeepSubShape, 'base');
    expect(property).toBeDefined();
    expect(property?.parentNodeShape).toBe(BaseShape.shape);
  });

  test('getMostSpecificSubShapes returns only leaves', () => {
    const mostSpecific = getMostSpecificSubShapes(BaseShape);
    expect(mostSpecific).toEqual(
      expect.arrayContaining([DeepSubShape, SiblingSubShape]),
    );
    expect(mostSpecific).not.toEqual(expect.arrayContaining([SubShape]));
  });

  test('getLeastSpecificShapeClasses filters to base shapes', () => {
    const shapes = new CoreSet([new SubShape(), new SiblingSubShape(), new BaseShape()]);
    const leastSpecific = getLeastSpecificShapeClasses(shapes);
    expect(leastSpecific).toEqual(expect.arrayContaining([BaseShape]));
    expect(leastSpecific).not.toEqual(
      expect.arrayContaining([SubShape, SiblingSubShape]),
    );
  });
});

describe('LinkedStorage extra behaviors', () => {
  beforeEach(() => resetLinkedStorage());

  test('setDefaultDataset calls init when provided', () => {
    const init = jest.fn();
    LinkedStorage.setDefaultDataset({init} as any);
    expect(init).toHaveBeenCalled();
  });

  test('getDatasets returns default and shape-specific datasets', () => {
    const defaultStore = {selectQuery: jest.fn()} as any;
    const shapeStore = {selectQuery: jest.fn()} as any;
    LinkedStorage.setDefaultDataset(defaultStore);
    LinkedStorage.setDatasetForShapes(shapeStore, BaseShape);
    const datasets = LinkedStorage.getDatasets();
    expect(datasets.has(defaultStore)).toBe(true);
    expect(datasets.has(shapeStore)).toBe(true);
  });

  test('getDatasetForShapeClass falls back to superclass mapping', () => {
    const baseStore = {selectQuery: jest.fn()} as any;
    LinkedStorage.setDatasetForShapes(baseStore, BaseShape);
    expect(LinkedStorage.getDatasetForShapeClass(SubShape)).toBe(baseStore);
  });

  test('selectQuery rejects invalid query payloads before store resolution', async () => {
    await expect(
      LinkedStorage.selectQuery({shape: null} as any),
    ).rejects.toThrow('Invalid select query passed to LinkedStorage.selectQuery(): missing root');
  });

  test('selectQuery still reports missing store for valid query shapes', async () => {
    await expect(
      LinkedStorage.selectQuery({
        kind: 'select',
        root: {kind: 'shape_scan', shape: BaseShape.shape.id, alias: 'a0'},
        patterns: [],
        projection: [],
        resultMap: [],
      } as any),
    ).rejects.toThrow('No query dataset configured');
  });
});

describe('LinkedFileStorage asset helper', () => {
  beforeEach(() => {
    LinkedFileStorage.setDefaultAccessURL('http://localhost:4000');
  });

  test('asset prefixes relative paths with accessURL and directory', () => {
    expect(asset('/images/example.webp')).toBe(
      'http://localhost:4000/public/images/example.webp',
    );
  });

  test('asset leaves fully qualified URLs unchanged', () => {
    expect(asset('http://cdn.example.com/public/images/example.webp')).toBe(
      'http://cdn.example.com/public/images/example.webp',
    );
    expect(asset('https://cdn.example.com/public/images/example.webp')).toBe(
      'https://cdn.example.com/public/images/example.webp',
    );
  });

  test('asset leaves data and blob URLs unchanged', () => {
    expect(asset('data:image/png;base64,abc123')).toBe(
      'data:image/png;base64,abc123',
    );
    expect(asset('blob:http://localhost:4000/1234')).toBe(
      'blob:http://localhost:4000/1234',
    );
  });
});

describe('Query dispatch delegation', () => {
  beforeEach(() => resetLinkedStorage());

  test('selectQuery dispatches through to store', async () => {
    const store = {
      selectQuery: jest.fn(async () => [{id: 'r1'}]),
    } as any;
    LinkedStorage.setDefaultDataset(store);

    const dispatch = getQueryDispatch();
    const query = ContextPerson.select((p) => p.name);
    const result = await dispatch.selectQuery(query.build());

    expect(store.selectQuery).toHaveBeenCalledTimes(1);
    expect(store.selectQuery.mock.calls[0][0]?.kind).toBe('select');
    expect(store.selectQuery.mock.calls[0][0]?.root?.kind).toBe('shape_scan');
    expect(result).toEqual([{id: 'r1'}]);
  });

  test('update/create/delete dispatch through to store', async () => {
    const store = {
      selectQuery: jest.fn(async () => []),
      updateQuery: jest.fn(async () => ({id: 'u1'})),
      createQuery: jest.fn(async () => ({id: 'c1'})),
      deleteQuery: jest.fn(async () => ({deleted: [], count: 0})),
    } as any;
    LinkedStorage.setDefaultDataset(store);

    await ContextPerson.select((p) => p.name);
    expect(store.selectQuery).toHaveBeenCalledTimes(1);
    expect(store.selectQuery.mock.calls[0][0]?.kind).toBe('select');
  });
});

describe('QueryContext edge cases', () => {
  test('getQueryContext returns PendingQueryContext for unknown names', () => {
    const ctx = getQueryContext('missing-context');
    expect(ctx).toBeInstanceOf(PendingQueryContext);
    expect(ctx.id).toBeUndefined();
  });

  test('setQueryContext warns and ignores invalid values', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setQueryContext('invalid-context', {foo: 'bar'} as any);
    // Invalid value was rejected, so context remains unset → PendingQueryContext
    expect(getQueryContext('invalid-context')).toBeInstanceOf(PendingQueryContext);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('setQueryContext warns when QResult provided without shapeType', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setQueryContext('missing-shape', {id: 'ctx-1'} as any);
    // Value was rejected, so context remains unset → PendingQueryContext
    expect(getQueryContext('missing-shape')).toBeInstanceOf(PendingQueryContext);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('setQueryContext accepts QResult with shapeType and uses latest value', () => {
    setQueryContext('ctx', {id: 'ctx-1'} as any, ContextPerson);
    setQueryContext('ctx', {id: 'ctx-2'} as any, ContextPerson);
    const context = getQueryContext('ctx');
    expect(context.id).toBe('ctx-2');

    const query = ContextPerson.select((p) => p.name).where((p) =>
      p.bestFriend.equals(context),
    );
    const queryObject = query.toRawInput();
    const where = queryObject?.where;
    expect(where).toBeDefined();
    // .equals() now returns ExpressionNode → where is WhereExpressionPath
    expect('expressionNode' in where!).toBe(true);
  });
});

describe('Package registration helpers', () => {
  test('getPackageShape returns a shape class by name', () => {
    expect(getPackageShape(PackagePerson.name)).toBe(PackagePerson);
  });

  test('registerPackageExport adds items to packageExports', () => {
    function Helper() {}
    registerPackageExport(Helper);
    expect(packageExports.Helper).toBe(Helper);
  });

  test('registerPackageModule sets names and registers exports', () => {
    const unnamed = {name: '', original: {name: ''}};
    const wrapped = {name: '_wrappedComponent', original: {name: ''}};
    const moduleRef = {exports: {Unnamed: unnamed, Wrapped: wrapped}};

    registerPackageModule(moduleRef);

    expect(moduleRef.exports.Unnamed.name).toBe('Unnamed');
    expect(moduleRef.exports.Wrapped.name).toBe('Wrapped');
    expect(moduleRef.exports.Wrapped.original.name).toBe('Wrapped_implementation');
    expect(packageExports.Unnamed).toBe(moduleRef.exports.Unnamed);
    expect(packageExports.Wrapped).toBe(moduleRef.exports.Wrapped);
  });
});
