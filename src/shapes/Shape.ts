/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeShapeData, PropertyShapeData} from './nodeShapeData.js';
import type {
  QueryBuildFn,
  QueryResponseToResultType,
  SelectAllQueryResponse,
  WhereClause,
} from '../queries/SelectQuery.js';
import type {NodeReferenceValue, UpdatePartial} from '../queries/QueryFactory.js';
import type {NodeId} from '../queries/MutationQuery.js';
import {QueryBuilder} from '../queries/QueryBuilder.js';
import {CreateBuilder} from '../queries/CreateBuilder.js';
import {UpdateBuilder} from '../queries/UpdateBuilder.js';
import {DeleteBuilder, type DeleteId} from '../queries/DeleteBuilder.js';
import type {ExpressionUpdateProxy, ExpressionUpdateResult} from '../expressions/ExpressionMethods.js';
import {getPropertyShapeByLabel} from '../utils/ShapeClass.js';
import {ShapeSet} from '../collections/ShapeSet.js';

//shape that returns property shapes for its keys
type AccessPropertiesShape<T extends Shape> = {
  [P in keyof T]: PropertyShapeData;
};
type PropertyShapeMapFunction<T extends Shape, ResponseType> = (
  p: AccessPropertiesShape<T>,
) => ResponseType;

/**
 * Concrete constructor type for Shape subclasses — used at runtime boundaries
 * (Builder `from()` methods, Shape static `this` parameters, mutation factories).
 *
 * Uses concrete `new` (not `abstract new`), so TypeScript allows direct
 * instantiation (`new shape()`) and property access (`shape.shape`) without casts.
 */
export type ShapeConstructor<S extends Shape = Shape> = (new (
  ...args: any[]
) => S) & {
  shape: NodeShapeData;
  targetClass?: NodeReferenceValue;
};

/**
 * @internal
 * Build a constructor-less, prototype-linked Shape used ONLY as a proxy /
 * metadata-carrier target inside the query DSL (never handed to consumers and
 * never persisted). It is a genuine `Shape` on the prototype chain — so
 * `.constructor`, the `nodeShape` getter, `ShapeSet`, and `getLeastSpecificShape`
 * all work — but it deliberately bypasses the `Shape` constructor, which is
 * guarded to reject direct instantiation. Not exported from the package index.
 */
export function createShapeTarget<S extends Shape>(
  shapeClass: ShapeConstructor<S> | typeof Shape,
  id?: string,
): S {
  const target = Object.create(shapeClass.prototype) as S;
  if (id !== undefined) {
    target.id = id;
  }
  return target;
}

export abstract class Shape {
  static targetClass: NodeReferenceValue = null;
  static shape: NodeShapeData;
  static typesToShapes: Map<string, Set<typeof Shape>> = new Map();

  __queryContextId?: string;
  /** The query-context name this shape was registered under (for `{@ctx}` refs). */
  __queryContextName?: string;
  id?: string;

  constructor(node?: string | NodeReferenceValue) {
    if (node) {
      this.id = typeof node === 'string' ? node : node.id;
    }
  }

  get nodeShape(): NodeShapeData {
    return (this.constructor as typeof Shape).shape;
  }

  get uri(): string {
    return this.id;
  }

  set uri(value: string) {
    this.id = value;
  }

  /**
   * @internal
   * @param shapeClass
   * @param type
   */
  static registerByType(shapeClass: typeof Shape, type?: NodeReferenceValue) {
    if (!type) {
      if (shapeClass === Shape) {
        return;
      }
      const shapeType = shapeClass.targetClass;
      if (shapeType) {
        type = shapeType;
      }
    }
    if (!type) {
      return;
    }
    const typeId = type.id;
    if (!this.typesToShapes.has(typeId)) {
      this.typesToShapes.set(typeId, new Set());
    }
    this.typesToShapes.get(typeId).add(shapeClass);
  }

  /**
   * Select properties of instances of this shape.
   * Chain `.for(id)` to target a single entity, or `.forAll(ids)` for multiple.
   * The select callback receives a proxy of the shape for type-safe property access.
   */
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
    selectFn: QueryBuildFn<S, R>,
  ): QueryBuilder<S, R, ResultType>;
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
  ): QueryBuilder<S, R, ResultType>;
  static select<
    S extends Shape,
    R = unknown,
    ResultType = QueryResponseToResultType<R, S>[],
  >(
    this: ShapeConstructor<S>,
    selectFn?: QueryBuildFn<S, R>,
  ): QueryBuilder<S, R, ResultType> {
    let builder = QueryBuilder.from(this) as QueryBuilder<S, any, any>;
    if (selectFn) {
      builder = builder.select(selectFn as any);
    }
    return builder as QueryBuilder<S, R, ResultType>;
  }

  /**
   * Select all decorated properties of this shape.
   * Chain `.for(id)` to target a single entity.
   */
  static selectAll<
    S extends Shape,
    ResultType = QueryResponseToResultType<
      SelectAllQueryResponse<S>,
      S
    >[],
  >(
    this: ShapeConstructor<S>,
  ): QueryBuilder<S, any, ResultType> {
    return QueryBuilder.from(this).selectAll() as QueryBuilder<S, any, ResultType>;
  }


  /**
   * Update properties of an instance of this shape.
   * Chain `.for(id)` to target a specific entity.
   *
   * ```typescript
   * await Person.update({name: 'Alice'}).for({id: '...'});
   * ```
   *
   * **`__id` is for *new* nodes only** — a fixed id for a nested node being
   * created (here, when **adding** to a relation: `update({friends: {add: {__id, name}}})`).
   * Do NOT put `__id` on a plain single-valued *replace* (`update({image: {__id, contentUrl}})`):
   * it re-targets that same node and *adds* another value instead of replacing
   * (breaks `sh:maxCount 1`). For a replace, **omit `__id`** — the engine drops the
   * old edge and writes a fresh node, so the value replaces cleanly. (Use `Shape.create`
   * for `__id` at creation; use `.delete()` or `{remove: […]}` for full owned-node cleanup.)
   */
  static update<S extends Shape>(
    this: ShapeConstructor<S>,
    data: (p: ExpressionUpdateProxy<S>) => ExpressionUpdateResult<S>,
  ): UpdateBuilder<S, any>;
  static update<S extends Shape, U extends UpdatePartial<S>>(
    this: ShapeConstructor<S>,
    data: U,
  ): UpdateBuilder<S, U>;
  static update<S extends Shape>(
    this: ShapeConstructor<S>,
    data: any,
  ): UpdateBuilder<S, any> {
    return UpdateBuilder.from(this).set(data) as unknown as UpdateBuilder<S, any>;
  }

  static create<S extends Shape, U extends UpdatePartial<S>>(
    this: ShapeConstructor<S>,
    updateObjectOrFn?: U,
  ): CreateBuilder<S, U> {
    let builder = CreateBuilder.from(this) as CreateBuilder<S, any>;
    if (updateObjectOrFn) {
      builder = builder.set(updateObjectOrFn);
    }
    return builder as unknown as CreateBuilder<S, U>;
  }

  static delete<S extends Shape>(
    this: ShapeConstructor<S>,
    id: DeleteId | DeleteId[] | NodeReferenceValue[],
  ): DeleteBuilder<S> {
    return DeleteBuilder.from(this, id) as DeleteBuilder<S>;
  }

  /** Delete all instances of this shape type. Returns void. */
  static deleteAll<S extends Shape>(
    this: ShapeConstructor<S>,
  ): DeleteBuilder<S, void> {
    return (DeleteBuilder.from(this) as DeleteBuilder<S>).all();
  }

  /** Delete instances matching a condition. Sugar for `.delete().where(fn)`. Returns void. */
  static deleteWhere<S extends Shape>(
    this: ShapeConstructor<S>,
    fn: WhereClause<S>,
  ): DeleteBuilder<S, void> {
    return (DeleteBuilder.from(this) as DeleteBuilder<S>).where(fn);
  }

  static mapPropertyShapes<S extends Shape, ResponseType = unknown>(
    this: ShapeConstructor<S>,
    mapFunction?: PropertyShapeMapFunction<S, ResponseType>,
  ): ResponseType {
    // SAFETY: dummyShape is used as a dynamic proxy target — we assign .proxy and
    // access arbitrary property names on it, which S doesn't declare.
    let dummyShape: any = createShapeTarget(this);
    dummyShape.proxy = new Proxy(dummyShape, {
      get(target, key, receiver) {
        if (typeof key === 'string') {
          if (key in dummyShape) {
            if (typeof dummyShape[key] === 'function') {
              return target[key].bind(target);
            }
            let propertyShape = getPropertyShapeByLabel(
              dummyShape.constructor,
              key.toString(),
            );
            if (propertyShape) {
              return propertyShape;
            }
            throw new Error(
              `${this.name}.${key.toString()} is missing a @linkedProperty decorator. This method can only access decorated get/set methods.`,
            );
          }
        }
      },
    });
    return mapFunction(dummyShape.proxy);
  }

  static getSetOf<T extends Shape>(
    this: ShapeConstructor<T>,
    values: Iterable<T | NodeReferenceValue | string>,
  ): ShapeSet<T> {
    const set = new ShapeSet<T>();
    for (const value of values) {
      if (value instanceof Shape) {
        set.add(value as T);
      } else {
        const instance = createShapeTarget(
          this,
          typeof value === 'string' ? value : value.id,
        );
        set.add(instance);
      }
    }
    return set;
  }
}
