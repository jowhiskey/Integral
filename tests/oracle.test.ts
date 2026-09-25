// Oracle tests: math.parse(...) → hand-written per-fixture walker → Integral AST
// → toMathNode() → evaluate() must equal direct math.parse(...).evaluate().
// The walker below is deliberately fixture-scoped — it is NOT the general
// mathjs→AST import path (string import is a separate concern).

import { describe, expect, it } from 'vitest';
import { parse, Unit } from 'mathjs';
import type {
  ConstantNode as MathConstantNode,
  FunctionNode as MathFunctionNode,
  MathNode as MathJsNode,
  OperatorNode as MathOperatorNode,
  ParenthesisNode as MathParenthesisNode,
  SymbolNode as MathSymbolNode,
} from 'mathjs';
import {
  FractionNode,
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

// ——— hand-written fixture walker (test-local, fixture constructs only) ———

const FLATTENABLE = new Set(['add', 'multiply']); // pure same-op chains only

function fixtureToAst(node: MathJsNode): MathNode {
  switch (node.type) {
    case 'ConstantNode':
      return new NumberNode((node as MathConstantNode).value as number);
    case 'SymbolNode':
      return new SymbolNode((node as MathSymbolNode).name);
    case 'ParenthesisNode':
      return new GroupNode(fixtureToAst((node as MathParenthesisNode).content));
    case 'FunctionNode': {
      const fn = node as MathFunctionNode;
      const name = typeof fn.fn === 'string' ? fn.fn : fn.fn.name;
      const args = fn.args.map(fixtureToAst);
      if (name === 'sqrt' && args.length === 1) return new RootNode(args[0]);
      if (name === 'nthRoot' && args.length === 2) return new RootNode(args[0], args[1]);
      throw new Error(`fixture walker: unexpected function ${name}`);
    }
    case 'OperatorNode': {
      const op = node as MathOperatorNode;
      const [left, right] = op.args;
      // Unit syntax: implicit multiply of a constant and a unit symbol.
      if (
        op.implicit &&
        op.fn === 'multiply' &&
        left.type === 'ConstantNode' &&
        right.type === 'SymbolNode' &&
        Unit.isValuelessUnit((right as MathSymbolNode).name)
      ) {
        return new UnitNode(new NumberNode((left as MathConstantNode).value as number), (right as MathSymbolNode).name);
      }
      if (op.fn === 'pow') {
        // Structural slots self-group: parens around base/exp are parse artifacts.
        const unwrap = (n: MathJsNode): MathJsNode =>
          n.type === 'ParenthesisNode' ? (n as MathParenthesisNode).content : n;
        return new PowerNode(fixtureToAst(unwrap(left)), fixtureToAst(unwrap(right)));
      }
      if (op.fn === 'divide') {
        return new FractionNode(fixtureToAst(left), fixtureToAst(right));
      }
      const astArgs = op.args.map(fixtureToAst);
      // n-ary flattening: merge pure same-op chains (a+b+c+d → one op node).
      const head = astArgs[0];
      const merged =
        head instanceof OperatorNode && head.op === op.fn && FLATTENABLE.has(op.fn)
          ? [...head.args, astArgs[1]]
          : astArgs;
      return new OperatorNode(op.fn, merged);
    }
    default:
      throw new Error(`fixture walker: unexpected mathjs node type ${node.type}`);
  }
}

const isUnit = (value: unknown): value is Unit =>
  value !== null && typeof value === 'object' && value instanceof Unit;

const expectSameValue = (result: unknown, oracle: unknown) => {
  if (isUnit(result) && isUnit(oracle)) {
    expect(result.equals(oracle)).toBe(true);
    expect(String(result)).toBe(String(oracle));
  } else {
    expect(result).toBe(oracle);
  }
};

// ——— oracle fixtures ———

describe('oracle: parse → fixture walker → AST → toMathNode → evaluate', () => {
  it('(5+3)*2 — the order-of-operations nightmare case', () => {
    const src = '(5+3)*2';
    const ast = fixtureToAst(parse(src));
    expect(ast).toEqual(
      new OperatorNode('multiply', [
        new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)])),
        new NumberNode(2),
      ]),
    );
    expectSameValue(ast.toMathNode().evaluate(), parse(src).evaluate());
    // Display-string test: evaluate is exactly 16.
    expect(ast.toMathNode().evaluate()).toBe(16);
  });

  it('a+b+c+d — n-ary flattening', () => {
    const src = 'a+b+c+d';
    const scope = { a: 1, b: 2, c: 3, d: 4 };
    const ast = fixtureToAst(parse(src));
    expect(ast).toEqual(new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b'), new SymbolNode('c'), new SymbolNode('d')]));
    expectSameValue(ast.toMathNode().evaluate(scope), parse(src).evaluate(scope));
  });

  it('50 mm — UnitNode roundtrip spike', () => {
    const src = '50 mm';
    const ast = fixtureToAst(parse(src));
    expect(ast).toEqual(new UnitNode(new NumberNode(50), 'mm'));
    const result = ast.toMathNode().evaluate();
    expect(isUnit(result)).toBe(true);
    expectSameValue(result, parse(src).evaluate());
  });

  it('2 * (50 mm) — UnitNode inside an explicit group', () => {
    const src = '2 * (50 mm)';
    const ast = fixtureToAst(parse(src));
    expect(ast).toEqual(
      new OperatorNode('multiply', [new NumberNode(2), new GroupNode(new UnitNode(new NumberNode(50), 'mm'))]),
    );
    expectSameValue(ast.toMathNode().evaluate(), parse(src).evaluate());
  });

  it('sqrt(16) + 2^(1/2) — root and pow', () => {
    const src = 'sqrt(16) + 2^(1/2)';
    const ast = fixtureToAst(parse(src));
    expect(ast).toEqual(
      new OperatorNode('add', [
        new RootNode(new NumberNode(16)),
        new PowerNode(new NumberNode(2), new FractionNode(new NumberNode(1), new NumberNode(2))),
      ]),
    );
    expectSameValue(ast.toMathNode().evaluate(), parse(src).evaluate());
  });
});

// ——— projection structure (spec table) ———

describe('toMathNode projections', () => {
  it('frac → OperatorNode("/", divide, [num, den])', () => {
    const m = new FractionNode(new NumberNode(1), new NumberNode(2)).toMathNode() as MathOperatorNode;
    expect(m.type).toBe('OperatorNode');
    expect(m.op).toBe('/');
    expect(m.fn).toBe('divide');
    expect(m.args.map((a) => a.type)).toEqual(['ConstantNode', 'ConstantNode']);
  });

  it('root → FunctionNode sqrt / nthRoot', () => {
    const sq = new RootNode(new NumberNode(16)).toMathNode() as MathFunctionNode;
    expect(sq.type).toBe('FunctionNode');
    expect(typeof sq.fn === 'string' ? sq.fn : sq.fn.name).toBe('sqrt');
    expect(sq.args).toHaveLength(1);
    const nth = new RootNode(new NumberNode(16), new NumberNode(3)).toMathNode() as MathFunctionNode;
    expect(typeof nth.fn === 'string' ? nth.fn : nth.fn.name).toBe('nthRoot');
    expect(nth.args).toHaveLength(2);
    expect(nth.evaluate()).toBe(2.5198420997897464);
  });

  it('sub → flat SymbolNode (x_max)', () => {
    const m = new SubscriptNode('x', 'max').toMathNode() as MathSymbolNode;
    expect(m.type).toBe('SymbolNode');
    expect(m.name).toBe('x_max');
  });

  it('group → ParenthesisNode', () => {
    const m = new GroupNode(new NumberNode(5)).toMathNode() as MathParenthesisNode;
    expect(m.type).toBe('ParenthesisNode');
    expect(m.content.type).toBe('ConstantNode');
  });

  it('op n-ary folds left-associatively', () => {
    const m = new OperatorNode('add', [
      new SymbolNode('a'),
      new SymbolNode('b'),
      new SymbolNode('c'),
    ]).toMathNode() as MathOperatorNode;
    expect(m.type).toBe('OperatorNode');
    expect(m.op).toBe('+');
    const [left, right] = m.args as [MathOperatorNode, MathSymbolNode];
    expect(left.type).toBe('OperatorNode');
    expect(left.args.map((a) => a.type)).toEqual(['SymbolNode', 'SymbolNode']);
    expect(right.type).toBe('SymbolNode');
    expect(m.evaluate({ a: 1, b: 2, c: 3 })).toBe(6);
  });

  it('unaryMinus stays unary', () => {
    const m = new OperatorNode('unaryMinus', [new NumberNode(5)]).toMathNode() as MathOperatorNode;
    expect(m.fn).toBe('unaryMinus');
    expect(m.args).toHaveLength(1);
    expect(m.evaluate()).toBe(-5);
  });

  it('throws on incomplete trees and unknown operators', () => {
    expect(() => new OperatorNode('add', [new NumberNode(5), null]).toMathNode()).toThrow(/incomplete/);
    expect(() => new FractionNode(new NumberNode(1), null).toMathNode()).toThrow(/incomplete/);
    expect(() => new GroupNode(null).toMathNode()).toThrow(/incomplete/);
    expect(() => new RootNode(null).toMathNode()).toThrow(/incomplete/);
    expect(() => new PowerNode(new NumberNode(2), null).toMathNode()).toThrow(/incomplete/);
    expect(() => new SubscriptNode('x', '').toMathNode()).toThrow(/incomplete/);
    expect(() => new UnitNode(null, 'mm').toMathNode()).toThrow(/incomplete/);
    expect(() => new OperatorNode('bogus', [new NumberNode(1), new NumberNode(2)]).toMathNode()).toThrow(/unknown operator/);
  });
});
