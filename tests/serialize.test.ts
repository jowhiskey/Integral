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
  fromJSON,
  isEvaluable,
  toJSON,
} from '../src/ast/index.js';

describe('roundtrip: fromJSON(toJSON(ast))', () => {
  const fixtures: [string, MathNode][] = [
    ['num', new NumberNode(3.14)],
    ['sym', new SymbolNode('x')],
    ['op n-ary', new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b'), new SymbolNode('c')])],
    ['op unary', new OperatorNode('unaryMinus', [new NumberNode(5)])],
    ['fn', new FunctionNode('sqrt', [new NumberNode(16)])],
    ['group', new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)]))],
    ['frac', new FractionNode(new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(4)])), new NumberNode(3))],
    ['pow', new PowerNode(new NumberNode(2), new FractionNode(new NumberNode(1), new NumberNode(2)))],
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
    ['incomplete: dangling op 5+', new OperatorNode('add', [new NumberNode(5), null])],
    ['incomplete: empty fraction', new FractionNode(new NumberNode(1), null)],
    ['incomplete: empty group', new GroupNode(null)],
    ['incomplete: empty root', new RootNode(null, null)],
    ['incomplete: empty sub', new SubscriptNode('', '')],
    ['incomplete: empty unit name', new UnitNode(new NumberNode(5), '')],
    ['incomplete: empty sym name', new SymbolNode('')],
  ];

  it.each(fixtures)('roundtrips %s', (_label, ast) => {
    const json = toJSON(ast);
    const restored = fromJSON(json);
    expect(restored).toBeInstanceOf(ast.constructor);
    expect(toJSON(restored)).toEqual(json);
  });

  it('omits root index when null (square root)', () => {
    const json = toJSON(new RootNode(new NumberNode(16)));
    expect('index' in json.root).toBe(false);
    const nth = toJSON(new RootNode(new NumberNode(16), new NumberNode(3)));
    expect(nth.root).toEqual({ type: 'root', radicand: { type: 'num', value: 16 }, index: { type: 'num', value: 3 } });
  });

  it('emits explicit null for empty slots', () => {
    const json = toJSON(new OperatorNode('add', [new NumberNode(5), null]));
    expect(json.root).toEqual({ type: 'op', op: 'add', args: [{ type: 'num', value: 5 }, null] });
  });

  it('accepts an entirely empty formula (root null or omitted)', () => {
    expect(fromJSON({ v: 1, root: null })).toBeNull();
    expect(fromJSON({ v: 1 })).toBeNull();
    expect(toJSON(null)).toEqual({ v: 1, root: null });
    expect(fromJSON(toJSON(null))).toBeNull();
    expect(isEvaluable(fromJSON({ v: 1, root: null }))).toBe(false);
  });

  it('accepts omitted empty slots on read', () => {
    expect(fromJSON({ v: 1, root: { type: 'frac', num: { type: 'num', value: 1 } } })).toEqual(
      new FractionNode(new NumberNode(1), null),
    );
    expect(fromJSON({ v: 1, root: { type: 'op', op: 'add', args: [{ type: 'num', value: 5 }] } })).toEqual(
      new OperatorNode('add', [new NumberNode(5)]),
    );
    expect(fromJSON({ v: 1, root: { type: 'root', radicand: { type: 'num', value: 16 } } })).toEqual(
      new RootNode(new NumberNode(16)),
    );
  });

  it('ignores unknown extra fields (additive-only contract)', () => {
    const ast = fromJSON({ v: 1, root: { type: 'num', value: 5, futureField: true } });
    expect(ast).toEqual(new NumberNode(5));
  });
});

describe('fromJSON rejects invalid trees', () => {
  it.each([
    ['envelope not an object', 42],
    ['envelope null', null],
    ['envelope array', [{ v: 1 }]],
    ['unsupported version', { v: 2, root: { type: 'num', value: 1 } }],
    ['missing version', { root: { type: 'num', value: 1 } }],
    ['unknown type tag', { v: 1, root: { type: 'matrix', args: [] } }],
    ['non-string type tag', { v: 1, root: { type: 5 } }],
    [
      'flat mixed token row inside a group',
      { v: 1, root: { type: 'group', parens: 'always', child: [{ type: 'num', value: 5 }, { type: 'sym', name: 'x' }] } },
    ],
    ['group child array of length 1', { v: 1, root: { type: 'group', parens: 'always', child: [{ type: 'num', value: 5 }] } }],
    ['group parens auto', { v: 1, root: { type: 'group', parens: 'auto', child: { type: 'num', value: 1 } } }],
    ['group parens missing', { v: 1, root: { type: 'group', child: { type: 'num', value: 1 } } }],
    ['op args not an array', { v: 1, root: { type: 'op', op: 'add', args: { 0: { type: 'num', value: 1 } } } }],
    ['num value is a string', { v: 1, root: { type: 'num', value: '5' } }],
    ['sym name is a number', { v: 1, root: { type: 'sym', name: 5 } }],
    ['root index is a string', { v: 1, root: { type: 'root', radicand: { type: 'num', value: 16 }, index: '3' } }],
    ['sub base is an object', { v: 1, root: { type: 'sub', base: { type: 'sym', name: 'x' }, sub: 'max' } }],
    ['unit value is a number', { v: 1, root: { type: 'unit', value: 50, unit: 'mm' } }],
    ['frac den is a string', { v: 1, root: { type: 'frac', num: { type: 'num', value: 1 }, den: 'x' } }],
    ['nested unknown type tag', { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'bogus' }] } }],
    ['flat row nested in op args', { v: 1, root: { type: 'op', op: 'add', args: [[{ type: 'num', value: 1 }]] } }],
  ])('rejects %s', (_label, bad) => {
    expect(() => fromJSON(bad)).toThrow();
  });
});
