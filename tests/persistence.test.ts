// Persistence round-trip: toJSON() → JSON.stringify → JSON.parse → fromJSON()
// is the documented host persistence path, so every envelope fromJSON accepts
// must survive a real persistence cycle. Ported from the adversarial audit:
// non-finite values are now rejected at the boundary (they can never survive
// the cycle), and -0 is normalized to the only zero JSON can carry.

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
  ValidationError,
  fromJSON,
  isEvaluable,
  toJSON,
} from '../src/ast/index.js';

/** The documented host persistence path: toJSON → stringify → parse → fromJSON. */
function persistCycle(ast: MathNode | null): { restored: MathNode | null; error: unknown } {
  const blob = JSON.parse(JSON.stringify(toJSON(ast)));
  try {
    return { restored: fromJSON(blob), error: undefined };
  } catch (error) {
    return { restored: null, error };
  }
}

describe('persistence round-trip survives JSON serialization', () => {
  it.each([
    ['num', new NumberNode(3.14)],
    ['sym', new SymbolNode('x')],
    ['op n-ary', new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b'), new SymbolNode('c')])],
    ['fn', new FunctionNode('sqrt', [new NumberNode(16)])],
    ['group', new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)]))],
    ['frac', new FractionNode(new NumberNode(1), new NumberNode(2))],
    ['pow', new PowerNode(new NumberNode(2), new NumberNode(3))],
    ['root square', new RootNode(new NumberNode(16))],
    ['root nth', new RootNode(new NumberNode(16), new NumberNode(3))],
    ['sub', new SubscriptNode('x', 'max')],
    ['unit', new UnitNode(new NumberNode(50), 'mm')],
    ['incomplete: dangling op', new OperatorNode('add', [new NumberNode(5), null])],
    ['incomplete: empty fraction', new FractionNode(new NumberNode(1), null)],
    ['empty formula', null],
  ])('%s survives a persistence cycle', (_label, ast) => {
    const { restored, error } = persistCycle(ast);
    expect(error).toBeUndefined();
    expect(toJSON(restored)).toEqual(toJSON(ast));
  });

  it('a legitimately NaN-producing formula (0/0) is persistable', () => {
    // Evaluation may produce NaN at runtime — that is none of the JSON
    // contract's business. The stored tree holds only finite literals.
    const ast = new FractionNode(new NumberNode(0), new NumberNode(0));
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate()).toBeNaN();
    const { restored, error } = persistCycle(ast);
    expect(error).toBeUndefined();
    expect(restored).toBeInstanceOf(FractionNode);
    expect(isEvaluable(restored)).toBe(true);
  });

  it('non-finite numbers never enter the persisted form (rejected at the boundary)', () => {
    // Adapted from the audit, which asserted non-finite values must survive
    // the cycle; the decided semantics reject them instead — JSON.stringify
    // collapses them to null, so no envelope carrying one can survive.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => fromJSON({ v: 1, root: { type: 'num', value } })).toThrow(ValidationError);
      const blob = JSON.stringify({ v: 1, root: { type: 'num', value } });
      // What a host would persist for such a value collapses to null —
      // exactly why the boundary rejects it.
      expect(JSON.parse(blob).root.value).toBeNull();
    }
  });

  it('toJSON output of every fromJSON-produced tree is loadable JSON', () => {
    const ast = fromJSON({ v: 1, root: { type: 'op', op: 'add', args: [{ type: 'num', value: 1 }, { type: 'num', value: -0 }] } })!;
    const blob = JSON.stringify(toJSON(ast));
    expect(blob).not.toContain('null');
    const restored = fromJSON(JSON.parse(blob))!;
    expect(toJSON(restored)).toEqual(toJSON(ast));
  });

  it('-0 is normalized once at the boundary and stays +0 across cycles', () => {
    const first = fromJSON({ v: 1, root: { type: 'num', value: -0 } }) as NumberNode;
    expect(Object.is(first.value, -0)).toBe(false);
    const second = fromJSON(JSON.parse(JSON.stringify(toJSON(first)))) as NumberNode;
    expect(Object.is(second.value, -0)).toBe(false);
    expect(second.value).toBe(0);
  });
});
