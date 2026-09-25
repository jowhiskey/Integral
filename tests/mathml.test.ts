import { describe, expect, it } from 'vitest';
import { FractionNode, GroupNode, MathNode, NumberNode, OperatorNode, RootNode, SubscriptNode, UnitNode } from '../src/ast/index.js';

describe('toMathML stub', () => {
  it('throws "not implemented" for every node type (MathML deferred)', () => {
    const nodes: MathNode[] = [
      new NumberNode(5),
      new OperatorNode('add', [new NumberNode(1), new NumberNode(2)]),
      new GroupNode(new NumberNode(5)),
      new FractionNode(new NumberNode(1), new NumberNode(2)),
      new RootNode(new NumberNode(16)),
      new SubscriptNode('x', 'max'),
      new UnitNode(new NumberNode(50), 'mm'),
    ];
    for (const node of nodes) {
      expect(() => node.toMathML()).toThrowError('toMathML: not implemented');
    }
  });
});
