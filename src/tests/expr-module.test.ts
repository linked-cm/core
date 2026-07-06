import {describe, expect, test} from '@jest/globals';
import {Expr} from '../expressions/Expr';
import {ExpressionNode} from '../expressions/ExpressionNode';
import type {IRExpression} from '../queries/IntermediateRepresentation';

const a: IRExpression = {kind: 'property_expr', sourceAlias: 'a0', property: 'x'};
const b: IRExpression = {kind: 'property_expr', sourceAlias: 'a0', property: 'y'};

const nodeA = new ExpressionNode(a);
const nodeB = new ExpressionNode(b);

/**
 * `Expr` carries only the non-property-first operations (see Expr.ts). Every
 * arithmetic/comparison/string/date/hash op lives on the fluent side and is
 * covered by `expression-node.test.ts` — `Expr` no longer mirrors them.
 */
describe('Expr module — non-property-first builders only', () => {
  test('now produces function_expr with no args', () => {
    expect(Expr.now().ir).toEqual({kind: 'function_expr', name: 'NOW', args: []});
  });

  test('concat produces CONCAT with all args', () => {
    const result = Expr.concat(nodeA, ' ', nodeB);
    expect(result.ir).toEqual({
      kind: 'function_expr',
      name: 'CONCAT',
      args: [a, {kind: 'literal_expr', value: ' '}, b],
    });
  });

  test('concat requires at least 2 args', () => {
    expect(() => (Expr as any).concat(nodeA)).toThrow('at least 2');
  });

  test('firstDefined produces COALESCE', () => {
    const result = Expr.firstDefined(nodeA, nodeB, 0);
    expect(result.ir).toEqual({
      kind: 'function_expr',
      name: 'COALESCE',
      args: [a, b, {kind: 'literal_expr', value: 0}],
    });
  });

  test('firstDefined requires at least 2 args', () => {
    expect(() => (Expr as any).firstDefined(nodeA)).toThrow('at least 2');
  });

  test('ifThen produces IF', () => {
    const cond = nodeA.gt(0);
    const result = Expr.ifThen(cond, 'yes', 'no');
    expect(result.ir).toEqual({
      kind: 'function_expr',
      name: 'IF',
      args: [cond.ir, {kind: 'literal_expr', value: 'yes'}, {kind: 'literal_expr', value: 'no'}],
    });
  });

  test('not negates (prefix form of the fluent .not())', () => {
    expect(Expr.not(nodeA).ir).toEqual(nodeA.not().ir);
  });
});
