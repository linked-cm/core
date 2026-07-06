import {
  type LiteralUpdateValue,
  type NodeDescriptionValue,
  NodeReferenceValue,
  type PropUpdateValue,
  QueryFactory,
  type SetModification,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  type UpdateNodePropertyValue,
  type UpdatePartial,
} from './QueryFactory.js';
import type {NodeShape, PropertyShape} from '../shapes/SHACL.js';
import {Shape} from '../shapes/Shape.js';
import {getShapeClass} from '../utils/ShapeClass.js';
import {isExpressionNode, ExpressionNode} from '../expressions/ExpressionNode.js';
import {createProxiedPathBuilder} from './ProxiedPathBuilder.js';
import {asContextRef} from './QueryContext.js';
import {shacl} from '../ontologies/shacl.js';

export type NodeId = {id: string} | string;

export class MutationQueryFactory extends QueryFactory {
  /**
   * Normalize raw create/update data into a {@link NodeDescriptionValue} — the
   * IR-free step shared by `toJSON()` and `lower()`. Kept on this base (which
   * imports no IR) so the builders can normalize for serialization without
   * pulling the canonical-IR pipeline.
   */
  describe(
    shape: NodeShape,
    data: unknown,
    allowTopLevelId: boolean = false,
  ): NodeDescriptionValue {
    return this.convertUpdateObject(data as any, shape, allowTopLevelId);
  }

  /** Normalize delete ids (strings / `{id}`) to `NodeReferenceValue[]` (IR-free). */
  normalizeNodeRefs(ids: NodeId[] | NodeId): NodeReferenceValue[] {
    return this.convertNodeReferences(ids);
  }

  protected convertUpdateObject(
    obj,
    shape: NodeShape,
    allowTopLevelId: boolean = false,
  ): NodeDescriptionValue {
    if (typeof obj === 'object' && !(obj instanceof Date) && obj !== null) {
      if (!allowTopLevelId && 'id' in obj) {
        throw new Error(
          'You cannot use id in the top level of an update object',
        );
      }
      return this.convertNodeDescription(obj, shape);
    } else if (typeof obj === 'function') {
      const shapeClass = shape.id ? getShapeClass(shape.id) : undefined;
      if (!shapeClass) {
        throw new Error(`Shape class not found for ${shape.id || 'unknown'}`);
      }
      const proxy = createProxiedPathBuilder(shapeClass);
      const result = obj(proxy);
      if (typeof result !== 'object' || result === null) {
        throw new Error('Update function must return an object');
      }
      return this.convertNodeDescription(result, shape);
    } else {
      throw new Error('Invalid update object');
    }
  }

  protected isSetModification(obj, shape) {
    let hasAdd = obj.add;
    let hasRemove = obj.remove;
    let numKeysExpected = (hasAdd ? 1 : 0) + (hasRemove ? 1 : 0);
    let numKeys = Object.getOwnPropertyNames(obj).length;
    // A set modification is ONLY add/remove keys. Mixing them with other keys
    // (e.g. {add:[…], name:'x'}) must NOT be silently treated as a set mod —
    // that dropped the sibling fields. Require an exact key-count match for
    // both add and remove (mirrors isSetModificationValue).
    return (hasAdd || hasRemove) && numKeysExpected === numKeys;
  }

  protected convertSetModification(
    obj: SetModification<any>,
    shape: PropertyShape,
  ): SetModificationValue {
    if (!obj.add && !obj.remove) {
      throw new Error('Set modification should have either add or remove key');
    }
    const res: SetModificationValue = {};
    if (obj.add) {
      res.$add = this.convertSetAddValue(obj.add, shape);
    }
    if (obj.remove) {
      res.$remove = this.convertSetRemoveValue(obj.remove, shape);
    }
    return res;
  }

  protected convertSetRemoveValue(
    obj: UpdatePartial | UpdatePartial[],
    shape: PropertyShape,
  ): NodeReferenceValue[] {
    //the user can either pass an array of node references or a single node reference
    //either way we should return an array of node reference values
    if (Array.isArray(obj)) {
      return obj.map((o) => this.convertSingleRemoveValue(o, shape));
    } else {
      return [this.convertSingleRemoveValue(obj, shape)];
    }
  }

  protected convertSetAddValue(
    obj: UpdatePartial | UpdatePartial[],
    shape: PropertyShape,
  ): UpdatePartial[] {
    if (Array.isArray(obj)) {
      return obj.map((o) => this.convertUpdateValue(o, shape) as UpdatePartial);
    } else {
      return [this.convertUpdateValue(obj, shape) as UpdatePartial];
    }
  }

  protected convertSingleRemoveValue(
    value,
    shape: PropertyShape,
  ): NodeReferenceValue {
    const ctx = asContextRef(value);
    if (ctx) {
      return ctx as unknown as NodeReferenceValue;
    }
    if (this.isNodeReference(value)) {
      return this.convertNodeReference(value);
    } else {
      throw new Error(
        `Invalid value for ${shape.label}.$remove. Expected an object with an id as key: {id:string}`,
      );
    }
  }

  protected convertNodeDescription(
    inputObj: Record<string, unknown>,
    shape: NodeShape,
  ): NodeDescriptionValue {
    // Shallow-copy so we never mutate the caller's object
    const obj = {...inputObj};
    const props = shape.getPropertyShapes(true);
    const fields: UpdateNodePropertyValue[] = [];
    let id;
    if ('__id' in obj) {
      //if the object has a __id key, then we should use that in the result
      id = obj.__id.toString();
      //but we should not include it in the fields
      delete obj.__id;
    } else if ('id' in obj) {
      //if the object has an id key alongside other data properties,
      //treat it as a nested create with a predefined ID
      id = String(obj.id);
      delete obj.id;
    }
    for (var key in obj) {
      let propShape = props.find((p) => p.label === key);
      if (!propShape) {
        throw Error(
          `Invalid property key: ${key}. The shape ${shape.label || shape.id.split('/').pop()} does not have a registered property with this name. Make sure the get/set method exists, and that it uses a @objectProperty or @literalProperty decorator.`,
        );
      } else {
        fields.push(this.createNodePropertyValue(obj[key], propShape));
      }
    }
    const res: NodeDescriptionValue = {
      fields,
      shape,
    };
    if (id) {
      res.__id = id;
    }

    return res;
  }

  protected createNodePropertyValue(
    value,
    propShape: PropertyShape,
  ): UpdateNodePropertyValue {
    this.validateAgainstShape(value, propShape);
    return {
      prop: propShape,
      val: this.convertUpdateValue(value, propShape),
    } as UpdateNodePropertyValue;
  }

  /**
   * Lightweight structural validation of a single property value against its
   * PropertyShape — cardinality (`minCount`/`maxCount`) and node-kind (literal
   * vs relation). This is *structural* only (from metadata already in hand); it
   * does not duplicate datatype/deep validation, which the store performs. It
   * fails fast at the call site with a clear message instead of surfacing a
   * confusing store error later.
   *
   * Skips values whose final shape isn't known here: computed expressions,
   * context refs, `unset` (null/undefined), and set-modifications (`{add,remove}`
   * — the resulting count depends on the node's current state).
   */
  protected validateAgainstShape(value, propShape: PropertyShape): void {
    // A `null` value clears the property. Clearing a required (minCount>=1)
    // property is a cardinality violation — the same as providing zero values —
    // so it is rejected exactly like an empty array (both spellings of "clear
    // it" behave identically).
    if (value === null) {
      if (typeof propShape.minCount === 'number' && propShape.minCount > 0) {
        throw new Error(
          `Property '${propShape.label || propShape.id}' requires at least ${propShape.minCount} value(s) and cannot be cleared.`,
        );
      }
      return;
    }
    if (
      value === undefined ||
      isExpressionNode(value) ||
      asContextRef(value) ||
      (typeof value === 'function') ||
      (typeof value === 'object' && this.isSetModification(value, propShape))
    ) {
      return;
    }

    const label = propShape.label || propShape.id;
    const elems = Array.isArray(value) ? value : [value];
    const count = elems.length;

    // --- cardinality ---
    if (typeof propShape.maxCount === 'number' && count > propShape.maxCount) {
      throw new Error(
        `Property '${label}' allows at most ${propShape.maxCount} value(s), but ${count} were provided.`,
      );
    }
    if (typeof propShape.minCount === 'number' && propShape.minCount > 0 && count < propShape.minCount) {
      throw new Error(
        `Property '${label}' requires at least ${propShape.minCount} value(s), but ${count} were provided.`,
      );
    }

    // --- node kind: literal vs relation ---
    const expectsLiteral = this.expectsLiteral(propShape);
    const expectsNode = this.expectsNode(propShape);
    if (!expectsLiteral && !expectsNode) return; // ambiguous/unspecified kind — don't enforce
    for (const el of elems) {
      if (el === null || el === undefined || isExpressionNode(el) || asContextRef(el)) continue;
      const isScalar =
        typeof el === 'string' ||
        typeof el === 'number' ||
        typeof el === 'boolean' ||
        el instanceof Date;
      if (expectsLiteral && !isScalar) {
        throw new Error(
          `Property '${label}' is a literal property but was given a ${typeof el === 'object' ? 'node/object' : typeof el} value.`,
        );
      }
      if (expectsNode && isScalar) {
        throw new Error(
          `Property '${label}' is a relation (object) property but was given a literal (${typeof el}). Provide a {id} reference or a nested object.`,
        );
      }
    }
  }

  /** True when the property clearly accepts only literal values. */
  private expectsLiteral(ps: PropertyShape): boolean {
    if (ps.nodeKind) return ps.nodeKind.id === shacl.Literal.id;
    return !!ps.datatype && !ps.valueShape;
  }

  /** True when the property clearly accepts only nodes (IRIs/blank nodes). */
  private expectsNode(ps: PropertyShape): boolean {
    if (ps.nodeKind) {
      return (
        ps.nodeKind.id === shacl.IRI.id ||
        ps.nodeKind.id === shacl.BlankNode.id ||
        ps.nodeKind.id === shacl.BlankNodeOrIRI.id
      );
    }
    return !!ps.valueShape;
  }

  protected convertUpdateValue(
    value,
    propShape?: PropertyShape,
    allowArrays: boolean = true,
  ): PropUpdateValue {
    // ExpressionNode → pass through as-is (will be converted to IRExpression by IRMutation)
    if (isExpressionNode(value)) {
      return value as unknown as PropUpdateValue;
    }

    // Query-context reference → preserve the live ref (do NOT collapse to {id},
    // which would read an unresolved `.id` as undefined). Handles both an unset
    // PendingQueryContext and a resolved context shape; both serialize as a {@ctx}
    // marker and are resolved — or throw — at lowering time.
    {
      const ctx = asContextRef(value);
      if (ctx) return ctx as unknown as PropUpdateValue;
    }

    //single value which will
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value instanceof Date
    ) {
      return value as LiteralUpdateValue;
    }

    //if multiple items are given as value of this prop
    if (Array.isArray(value)) {
      if (!allowArrays) {
        throw new Error('Nested arrays are not allowed as values of keys');
      }
      //then convert each value, but disallow nested arrays moving forward
      return value.map((o) => {
        return this.convertUpdateValue(o, propShape, false);
      }) as SinglePropertyUpdateValue[];
    } else if (typeof value === 'undefined') {
      return value;
    } else if (value === null) {
      //unsetting a value with null is also possible. But we pass it as undefined in the query object
      return undefined;
    } else if (typeof value === 'object') {
      if (this.isNodeReference(value)) {
        return this.convertNodeReference(value);
      } else {
        let valueShape: NodeShape = null;
        if (propShape.valueShape) {
          const shapeClass = getShapeClass(propShape.valueShape);
          valueShape = shapeClass?.shape || null;
          if (!valueShape) {
            throw new Error(
              `Shape class not found for ${propShape.valueShape.id}`,
            );
          }
        }
        //pass the value shape of the property as the node shape of this value
        if (!propShape.valueShape) {
          //It's possible to define the shape of the value in the value itself for properties who do not define the shape in their objectProperty
          if (value.shape) {
            if (!value.shape.shape || typeof (value.shape.shape as NodeShape).getPropertyShapes !== 'function') {
              throw new Error(
                `The value of property "shape" is invalid and should be a class that extends Shape.`,
              );
            }
            valueShape = (value.shape as typeof Shape).shape;
          } else {
            //TODO: not sure if this should be an error. Does every @linkedObject need to define the shape of the values?
            // If not, then how do we continue? because currently we use the value shape to look up further property shapes
            throw new Error(
              `Cannot update properties with plain objects if the shape of the values is not known. Make sure get/set ${propShape.parentNodeShape.label}.${propShape.label} defines the 'shape' key in its @objectProperty decorator.`,
            );
          }
        }
        //never keep a shape key in the value object
        if (value.shape) {
          //double check that IF a shape value is provided, that it matches the shape from the @objectProperty decorator
          if ((value.shape as typeof Shape).shape.id !== valueShape.id) {
            throw new Error(
              `The property 'shape' is reserved in LINCD and should not be used here in this way. The ${propShape.label} property already defines the shape of the value as ${propShape.label}. If you want to use a different shape, use the 'shape' key in the @objectProperty decorator.`,
            );
          }
          delete value.shape;
        }

        if (this.isSetModification(value, propShape)) {
          return this.convertSetModification(value, propShape);
        } else {
          return this.convertNodeDescription(value, valueShape);
        }
      }
    }
    throw new Error(`Unsupported update value type: ${typeof value}`);
  }

  protected isNodeReference(obj): obj is NodeReferenceValue {
    //check if obj is an object with only an id property
    //if additional data properties are present, it's a nested create with predefined ID
    return typeof obj === 'object' && obj !== null && 'id' in obj && Object.keys(obj).length === 1;
  }

  protected convertNodeReferences(
    input: NodeId[] | NodeId,
  ): NodeReferenceValue[] {
    if (Array.isArray(input)) {
      return input.map((o) => {
        return this.convertNodeReferenceOrString(o);
      });
    } else {
      return [this.convertNodeReferenceOrString(input)];
    }
  }

  protected convertNodeReferenceOrString(
    o: {id: string} | string,
  ): NodeReferenceValue {
    if (typeof o === 'string') {
      return {id: o};
    } else if (this.isNodeReference(o)) {
      return this.convertNodeReference(o);
    } else {
      throw new Error(`Invalid node reference: ${JSON.stringify(o)}`);
    }
  }

  protected convertNodeReference(obj: {id: string}): NodeReferenceValue {
    return {id: obj.id};
  }
}
