import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import type {NodeShape, PropertyShape} from '../shapes/SHACL.js';
import type {ICoreIterable} from '../interfaces/ICoreIterable.js';
import type {NodeReferenceValue} from './NodeReference.js';

const resolveTargetClassId = (
  targetClass?: NodeReferenceValue | null,
): string | null => {
  if (!targetClass) return null;
  return targetClass.id ?? null;
};

let subShapesCache: Map<string, (typeof Shape)[]> = new Map();
let mostSpecificSubShapesCache: Map<string, (typeof Shape)[]> = new Map();
let nodeShapeToShapeClass: Map<string, typeof Shape> = new Map();
let shouldResetCache = false;
const warnedDuplicateBases = new Set<string>();

export function addNodeShapeToShapeClass(
  nodeShape: NodeShape,
  shapeClass: typeof Shape,
) {
  if (!nodeShape?.id) {
    return;
  }
  // Dev guardrail for IDENTITY duplication. Shape URIs embed `constructor.name`
  // (getNodeShapeUri). If a bundler emits >1 copy of a framework package, the copies
  // are renamed `Person`→`Person2`/`3`, so a mangled URI registers alongside the clean
  // one — the exact failure that silently breaks cross-runtime shape lookup (`Person3`
  // on the FE ≠ `Person` on the backend). Warn ONCE per base so a build-config
  // regression (e.g. a dropped `optimizeDeps.exclude`) surfaces loudly instead of
  // no-op'ing a query at forward time. Dev-only — prod is minified and would false-fire.
  if (process.env.NODE_ENV !== 'production') {
    const id = nodeShape.id;
    const base = id.replace(/\d+$/, '');
    const existing = nodeShapeToShapeClass.get(base);
    if (base !== id && existing && !warnedDuplicateBases.has(base)) {
      // A real duplicate is the SAME logical shape (same targetClass) registered under
      // a mangled name; a legit digit-suffixed sibling (e.g. `OAuth2` vs `OAuth`)
      // targets a different class. Warn only when they match (or targetClass is absent).
      const newTarget = (shapeClass as any).targetClass?.id;
      const existingTarget = (existing as any).targetClass?.id;
      if (!newTarget || !existingTarget || newTarget === existingTarget) {
        warnedDuplicateBases.add(base);
        console.warn(
          `[linked] Shape identity duplication: '${id}' registered alongside '${base}'. ` +
            `A bundler emitted >1 copy of this package — cross-runtime shape lookup will ` +
            `break. Check the cli vite-config single-instance levers (optimizeDeps.exclude ` +
            `/ ssr.noExternal).`,
        );
      }
    }
  }
  nodeShapeToShapeClass.set(nodeShape.id, shapeClass);
  //make sure that the cache is reset after the next event loop
  if (!shouldResetCache) {
    shouldResetCache = true;
    setTimeout(() => {
      subShapesCache.clear();
      mostSpecificSubShapesCache.clear();
      shouldResetCache = false;
    }, 0);
  }
}

export function getShapeClass(
  nodeShape: NodeReferenceValue | {id: string} | string,
): ShapeConstructor | undefined {
  const id = typeof nodeShape === 'string' ? nodeShape : nodeShape?.id;
  if (!id) {
    return undefined;
  }
  // SAFETY: The map stores `typeof Shape` (abstract), but registered shapes are always
  // concrete subclasses with a constructor and static .shape — i.e. ShapeConstructor.
  return nodeShapeToShapeClass.get(id) as unknown as ShapeConstructor | undefined;
}

/**
 * Returns all registered shape classes (keyed by NodeShape URI).
 */
export function getAllShapeClasses(): Map<string, typeof Shape> {
  return nodeShapeToShapeClass;
}

/**
 * Returns all the sub shapes of the given shape
 * That is all the shapes that extend this shape
 * @param shape
 */

export function getSubShapesClasses(
  shape: typeof Shape | (typeof Shape)[],
  _internalKey?: string,
): (typeof Shape)[] {
  let key = _internalKey || getKey(shape);
  if (!subShapesCache.has(key)) {
    //apply the hasSuperclass function to the shape
    let filterFunction = applyFnToShapeOrArray(shape, hasSubClass);
    //filter and then sort the results based on their inheritance (most specific classes first, so we use hasSuperClass for the sorting)
    subShapesCache.set(
      key,
      filterShapeClasses(filterFunction).sort((a, b) => {
        return hasSubClass(a, b) ? 1 : -1;
      }),
    );
  }
  //return a copy of the array to prevent it from being modified
  return [...subShapesCache.get(key)];
}

/**
 * Returns all the superclasses of the given shape
 * That is all the shapes that it extends.
 * Results are sorted from most specific to least specific
 * @param shape
 */
export function getSuperShapesClasses(
  shape: typeof Shape | (typeof Shape)[],
): (typeof Shape)[] {
  //apply the hasSuperclass function to the shape
  let filterFunction = applyFnToShapeOrArray(shape, hasSuperClass);
  //filter and then sort the results based on their inheritance
  return filterShapeClasses(filterFunction).sort((a, b) => {
    return hasSubClass(a, b) ? 1 : -1;
  });
}

export function getPropertyShapeByLabel(
  shapeClass: typeof Shape,
  label: string,
): PropertyShape {
  //get all the shapes that this shape extends
  let shapeChain: (typeof Shape)[] = getSuperShapesClasses(
    shapeClass as typeof Shape,
  );
  //include the shape itself as the first shape in the array
  shapeChain.unshift(shapeClass as typeof Shape);

  let propertyShape: PropertyShape;
  for (let sClass of shapeChain) {
    propertyShape = sClass.shape
      .getPropertyShapes()
      .find((propertyShape) => propertyShape.label === label);
    if (propertyShape) {
      break;
    }
  }
  return propertyShape;
}

export function hasSuperClass(a: Function, b: Function) {
  return (a as Function).prototype instanceof b;
}

export function hasSubClass(a: Function, b: Function) {
  return (b as Function).prototype instanceof a;
}

function applyFnToShapeOrArray(shape, filterFn) {
  if (Array.isArray(shape)) {
    return (shapeClass) => {
      //returns true if one of the given shapes extends the shapeClass passed as argument
      return (shape as Function[]).some((s) => filterFn(s, shapeClass));
    };
  } else {
    //first argument will be the given shape class, second argument will be each stored shape class in the map
    //will filter down where the given shape extends the stored shape
    return filterFn.bind(null, shape);
  }
}

function filterShapeClasses(filterFn) {
  let result = [];
  nodeShapeToShapeClass.forEach((shapeClass) => {
    if (filterFn(shapeClass)) {
      result.push(shapeClass);
    }
  });
  return result;
}

export function getLeastSpecificShapeClasses(shapes: ICoreIterable<Shape>) {
  let shapeClasses = shapes.map((shape) =>
    getShapeClass(shape.nodeShape.id),
  );
  return filterShapesToLeastSpecific(shapeClasses);
}

export function getMostSpecificSubShapes(
  shape: typeof Shape | (typeof Shape)[],
): (typeof Shape)[] {
  if (!Array.isArray(shape)) {
    shape = [shape];
  }
  //get the subshapes of the given shapes
  let key = shape.map((s) => s.name).join(',');
  if (!mostSpecificSubShapesCache.has(key)) {
    //get the subshapes of the given shapes
    let subShapes: (typeof Shape)[] = getSubShapesClasses(shape, key);
    //filter them down to the most specific ones (that are not extended by any other shape)
    mostSpecificSubShapesCache.set(key, filterShapesToMostSpecific(subShapes));
  }
  return mostSpecificSubShapesCache.get(key);
}

/**
 * Filters out all shapes that are extended by any other shape in the given set/array
 * @param subShapes
 */
function filterShapesToMostSpecific(subShapes) {
  return subShapes.filter((subShape) => {
    return !subShapes.some((otherSubShape) => {
      return otherSubShape.prototype instanceof subShape;
    });
  });
}

/**
 * Filters out all shapes that extend any other shape in the given set/array
 * @param shapeClasses
 */
function filterShapesToLeastSpecific(shapeClasses) {
  return shapeClasses.filter((shapeClass) => {
    return !shapeClasses.some((otherShapeClass) => {
      return (
        otherShapeClass !== shapeClass &&
        shapeClass.prototype instanceof otherShapeClass
      );
    });
  });
}

function getKey(shape: typeof Shape | (typeof Shape)[]) {
  return Array.isArray(shape)
    ? shape.map((s) => getShapeKey(s)).join(',')
    : getShapeKey(shape);
}

function getShapeKey(shape: typeof Shape) {
  //return a unique string for each shape
  return (
    resolveTargetClassId(shape.targetClass) ||
    shape.name + shape.prototype.constructor.toString().substring(0, 80)
  );
}

