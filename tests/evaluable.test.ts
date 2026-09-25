import { describe, expect, it } from 'vitest';
import {
  FractionNode,
  FunctionNode,
  GroupNode,
  MathNode,
  NumberNode,
  OperatorNode,
  PowerNode,
  RootNode,
  SubscriptNode,
  SymbolNode,
  UnitNode,
  isEvaluable,
} from '../src/ast/index.js';

describe('isEvaluable — all slots filled, no dangling operators', () => {
  it('accepts complete trees of every node type', () => {
    const evaluable: [string, MathNode][] = [
      ['num', new NumberNode(5)],
      ['sym', new SymbolNode('x')],
      ['op binary', new OperatorNode('add', [new NumberNode(1), new NumberNode(2)])],
      ['op n-ary', new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b'), new SymbolNode('c')])],
      ['op unary', new OperatorNode('unaryMinus', [new NumberNode(5)])],
      ['fn', new FunctionNode('sqrt', [new NumberNode(16)])],
      ['group', new GroupNode(new NumberNode(5))],
      ['frac', new FractionNode(new NumberNode(1), new NumberNode(2))],
      ['pow', new PowerNode(new NumberNode(2), new NumberNode(3))],
      ['root square', new RootNode(new NumberNode(16))],
      ['root nth', new RootNode(new NumberNode(16), new NumberNode(3))],
      ['sub', new SubscriptNode('x', 'max')],
      ['unit', new UnitNode(new NumberNode(50), 'mm')],
      [
        'composite (5+3)*2',
        new OperatorNode('multiply', [
          new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)])),
          new NumberNode(2),
        ]),
      ],
      [
        'composite 2 * (50 mm)',
        new OperatorNode('multiply', [new NumberNode(2), new GroupNode(new UnitNode(new NumberNode(50), 'mm'))]),
      ],
    ];
    for (const [label, ast] of evaluable) {
      expect(isEvaluable(ast), label).toBe(true);
    }
  });

  it('rejects null and incomplete trees', () => {
    const notEvaluable: [string, MathNode | null][] = [
      ['null', null],
      ['empty sym name', new SymbolNode('')],
      ['dangling op 5+', new OperatorNode('add', [new NumberNode(5), null])],
      ['dangling op, single arg', new OperatorNode('add', [new NumberNode(5)])],
      ['empty op name', new OperatorNode('', [new NumberNode(1), new NumberNode(2)])],
      ['unknown op', new OperatorNode('bogus', [new NumberNode(1), new NumberNode(2)])],
      ['unary with two args', new OperatorNode('unaryMinus', [new NumberNode(1), new NumberNode(2)])],
      ['empty fn name', new FunctionNode('', [])],
      ['fn with empty slot', new FunctionNode('sqrt', [null])],
      ['empty group', new GroupNode(null)],
      ['frac with empty den', new FractionNode(new NumberNode(1), null)],
      ['pow with empty exp', new PowerNode(new NumberNode(2), null)],
      ['root with empty radicand', new RootNode(null)],
      ['root with incomplete index', new RootNode(new NumberNode(16), new SymbolNode(''))],
      ['empty sub label', new SubscriptNode('x', '')],
      ['empty unit name', new UnitNode(new NumberNode(5), '')],
      ['unit with empty value', new UnitNode(null, 'mm')],
      ['nested incomplete', new OperatorNode('add', [new NumberNode(1), new FractionNode(null, null)])],
    ];
    for (const [label, ast] of notEvaluable) {
      expect(isEvaluable(ast), label).toBe(false);
    }
  });
});
