/**
 * Focused unit tests for the Z-c expression codec (ZcExpression.ts).
 * The comprehensive semantic check is dsl-json-roundtrip.test.ts; these pin the
 * exact wire shapes and the codec's structural round-trip in isolation.
 */
import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {
  ExpressionNode,
  tracedPropertyExpression,
  tracedAliasExpression,
} from '../expressions/ExpressionNode';
import {
  encodeValueExpr,
  decodeValueExpr,
  encodeCondition,
  decodeCondition,
  pathToSegmentIds,
  segmentsToPath,
} from '../queries/ZcExpression';
import type {IRExpression} from '../queries/IntermediateRepresentation';

const shape = Person.shape;
const nameSegs = pathToSegmentIds(shape, 'name');
const ageSegs = pathToSegmentIds(shape, 'birthDate');
const friendNameSegs = pathToSegmentIds(shape, 'friends.name');

const lit = (value: unknown): IRExpression => ({kind: 'literal_expr', value: value as never});
const prop = (segs: string[]) => tracedPropertyExpression(segs);
const cmp = (op: any, left: IRExpression, right: IRExpression): IRExpression => ({
  kind: 'binary_expr',
  operator: op,
  left,
  right,
});

describe('ZcExpression — path helpers', () => {
  test('segmentsToPath / pathToSegmentIds round-trip', () => {
    expect(segmentsToPath(friendNameSegs)).toBe('friends.name');
    expect(pathToSegmentIds(shape, 'friends.name')).toEqual(friendNameSegs);
  });
});

describe('ZcExpression — value tier', () => {
  test('literal → bare scalar', () => {
    expect(encodeValueExpr(lit('Alice'), new Map())).toBe('Alice');
    expect(encodeValueExpr(lit(42), new Map())).toBe(42);
  });

  test('property → {path}', () => {
    const p = prop(nameSegs);
    expect(encodeValueExpr(p.ir, p._refs)).toEqual({path: 'name'});
  });

  test('node reference → {id}', () => {
    expect(encodeValueExpr({kind: 'reference_expr', value: 'x:1'}, new Map())).toEqual({id: 'x:1'});
  });

  test('context ref → {$ctx} and {$ctx,path}', () => {
    expect(encodeValueExpr({kind: 'reference_expr', contextName: 'user'}, new Map())).toEqual({
      $ctx: 'user',
    });
    expect(
      encodeValueExpr(
        {kind: 'context_property_expr', contextName: 'user', property: nameSegs[0]},
        new Map(),
      ),
    ).toEqual({$ctx: 'user', path: 'name'});
  });

  test('arithmetic → S-expr', () => {
    const p = prop(ageSegs);
    expect(encodeValueExpr(cmp('+', p.ir, lit(1)), p._refs)).toEqual(['+', {path: 'birthDate'}, 1]);
  });

  test('decode {path} → property_expr with refs', () => {
    const {ir, refs} = decodeValueExpr({path: 'name'}, shape);
    expect(ir.kind).toBe('property_expr');
    expect([...refs.values()][0]).toEqual(nameSegs);
  });
});

describe('ZcExpression — condition tier', () => {
  test('equality → implicit-equals path-keyed', () => {
    const p = prop(nameSegs);
    const node = new ExpressionNode(cmp('=', p.ir, lit('Alice')), p._refs);
    expect(encodeCondition(node, shape)).toEqual({name: 'Alice'});
  });

  test('comparison → operator map', () => {
    const p = prop(nameSegs);
    const node = new ExpressionNode(cmp('>', p.ir, lit(5)), p._refs);
    expect(encodeCondition(node, shape)).toEqual({name: {'>': 5}});
  });

  test('AND of distinct paths → merged multi-key object', () => {
    const a = prop(nameSegs);
    const b = prop(ageSegs);
    const node = new ExpressionNode(
      {
        kind: 'logical_expr',
        operator: 'and',
        expressions: [cmp('=', a.ir, lit('Alice')), cmp('>', b.ir, lit(5))],
      },
      new Map([...a._refs, ...b._refs]),
    );
    expect(encodeCondition(node, shape)).toEqual({name: 'Alice', birthDate: {'>': 5}});
  });

  test('relation property comparison → {rel: {id}} decodes to property_expr (no traversal)', () => {
    // `p.bestFriend.equals(x)` compares the property VALUE → property_expr, not a
    // traversal/alias. (alias_expr is only the bare subject — empty path.)
    const p = prop(pathToSegmentIds(shape, 'bestFriend'));
    const node = new ExpressionNode(cmp('=', p.ir, {kind: 'reference_expr', value: 'p:3'}), p._refs);
    const zc = encodeCondition(node, shape);
    expect(zc).toEqual({bestFriend: {id: 'p:3'}});
    const where: any = decodeCondition(zc, shape);
    expect(where.expressionNode.ir.left.kind).toBe('property_expr');
  });

  test('bare subject comparison (empty path) → {"": {id}} decodes to alias_expr', () => {
    const a = tracedAliasExpression([]);
    const node = new ExpressionNode(cmp('=', a.ir, {kind: 'reference_expr', value: 'p:1'}), a._refs);
    const zc = encodeCondition(node, shape);
    expect(zc).toEqual({'': {id: 'p:1'}});
    const where: any = decodeCondition(zc, shape);
    expect(where.expressionNode.ir.left.kind).toBe('alias_expr');
  });

  test('decodeCondition(encodeCondition) is structurally stable for a comparison', () => {
    const p = prop(nameSegs);
    const node = new ExpressionNode(cmp('=', p.ir, lit('Alice')), p._refs);
    const where: any = decodeCondition(encodeCondition(node, shape), shape);
    expect(where.expressionNode.ir.kind).toBe('binary_expr');
    expect(where.expressionNode.ir.operator).toBe('=');
    expect(where.expressionNode.ir.left.kind).toBe('property_expr');
    expect(where.expressionNode.ir.right).toEqual(lit('Alice'));
  });
});
