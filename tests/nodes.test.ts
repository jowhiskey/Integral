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
} from '../src/ast/index.js';

describe('node classes', () => {
  it('construct every node type with its spec fields', () => {
    const nodes: [MathNode, Record<string, unknown>][] = [
      [new NumberNode(3.5), { type: 'num', value: 3.5 }],
      [new SymbolNode('x'), { type: 'sym', name: 'x' }],
      [new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b')]), { type: 'op', op: 'add' }],
      [new FunctionNode('sqrt', [new NumberNode(16)]), { type: 'fn', name: 'sqrt' }],
      [new GroupNode(new NumberNode(1)), { type: 'group', parens: 'always' }],
      [new FractionNode(new NumberNode(1), new NumberNode(2)), { type: 'frac' }],
      [new PowerNode(new NumberNode(2), new NumberNode(3)), { type: 'pow' }],
      [new RootNode(new NumberNode(16)), { type: 'root', index: null }],
      [new RootNode(new NumberNode(16), new NumberNode(3)), { type: 'root' }],
      [new SubscriptNode('x', 'max'), { type: 'sub', base: 'x', sub: 'max' }],
      [new UnitNode(new NumberNode(50), 'mm'), { type: 'unit', unit: 'mm' }],
    ];
    for (const [node, expected] of nodes) {
      for (const [key, value] of Object.entries(expected)) {
        expect(node[key as keyof MathNode]).toEqual(value);
      }
    }
  });

  it('holds null in empty slots for incomplete trees', () => {
    expect(new OperatorNode('add', [new NumberNode(5), null]).args[1]).toBeNull();
    expect(new GroupNode(null).child).toBeNull();
    expect(new FractionNode(null, null).num).toBeNull();
  });
});
