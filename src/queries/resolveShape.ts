import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {getOrCreateShapeAdapter, getShapeClass} from '../utils/ShapeClass.js';

/**
 * Resolve a shape class or IRI string to a ShapeConstructor.
 *
 * Shared utility used by QueryBuilder, CreateBuilder, UpdateBuilder, and DeleteBuilder
 * to normalize their shape input.
 *
 * @throws If a string IRI cannot be resolved via the shape registry.
 */
export function resolveShape<S extends Shape>(
  shape: ShapeConstructor<S> | string,
): ShapeConstructor<S> {
  if (typeof shape === 'string') {
    // An authored class first; otherwise a constructor derived from the registered
    // metadata, so a project-authored shape that exists only as data resolves too.
    const shapeClass = getShapeClass(shape) ?? getOrCreateShapeAdapter(shape);
    if (!shapeClass) {
      throw new Error(`Cannot resolve shape for '${shape}'`);
    }
    return shapeClass as ShapeConstructor<S>;
  }
  return shape;
}
