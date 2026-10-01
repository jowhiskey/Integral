// fromJSON boundary validation: typed rejections for non-finite numbers,
// -0 normalization, operator arity rules, subscript label integrity, the
// custom-vocabulary format gate, and the structural budgets (depth, node
// count). Ported from the adversarial audit red tests, adapted to the
// decided semantics where the audit asserted a different outcome.

import { describe, expect, it } from 'vitest';
import {
  AST_LIMITS,
  OperatorNode,
  SubscriptNode,
  UnitNode,
  ValidationError,
  ValidationLimitError,
  fromJSON,
  isEvaluable,
  toJSON,
  type StaticVocabulary,
} from '../src/ast/index.js';

const unitEnvelope = (unit: string) => ({
  v: 1 as const,
  root: { type: 'unit', value: { type: 'num', value: 5 }, unit },
});

describe('fromJSON rejects non-finite numbers (persistence-cycle contract)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s in the num channel with a typed validation error', (_label, value) => {
    // JSON.stringify collapses non-finite numbers to null, so an envelope
    // carrying one could never survive a persistence cycle — the boundary
    // rejects instead of emitting an unloadable tree.
    expect(() => fromJSON({ v: 1, root: { type: 'num', value } })).toThrow(ValidationError);
    expect(() => fromJSON({ v: 1, root: { type: 'num', value } })).toThrow(/finite number/);
  });

  it('rejects a non-finite number nested deep in the tree', () => {
    const bad = {
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [{ type: 'num', value: 1 }, { type: 'frac', num: { type: 'num', value: Number.POSITIVE_INFINITY }, den: { type: 'num', value: 3 } }],
      },
    };
    expect(() => fromJSON(bad)).toThrow(ValidationError);
  });

  it('normalizes -0 to 0 (JSON cannot carry the sign)', () => {
    // Decision within the decided boundary: normalize, not reject. -0 is
    // numerically 0, and the sign is unrepresentable in the JSON contract —
    // rejecting would destroy a valid formula to protect information no
    // persistence cycle can carry anyway.
    const ast = fromJSON({ v: 1, root: { type: 'num', value: -0 } })!;
    expect(Object.is((ast as { value: number }).value, -0)).toBe(false);
    expect((ast as { value: number }).value).toBe(0);
    // And the normalization is a fixed point of the persistence cycle.
    const restored = fromJSON(JSON.parse(JSON.stringify(toJSON(ast))))!;
    expect((restored as { value: number }).value).toBe(0);
  });
});

describe('fromJSON enforces operator arity invariants', () => {
  it.each([
    ['unaryMinus with two args', 'unaryMinus', [{ type: 'num', value: 5 }, { type: 'num', value: 3 }]],
    ['unaryPlus with two args', 'unaryPlus', [{ type: 'num', value: 5 }, { type: 'num', value: 3 }]],
    ['unaryMinus with zero args', 'unaryMinus', []],
    ['unaryPlus with zero args', 'unaryPlus', []],
  ])('rejects %s', (_label, op, args) => {
    // A unary op with any arity other than exactly one is a shape no typed
    // input can produce; it used to pass the boundary and die only at the
    // evaluation fold.
    expect(() => fromJSON({ v: 1, root: { type: 'op', op, args } })).toThrow(ValidationError);
  });

  it('keeps a dangling unary op legal (incomplete tree: args [null])', () => {
    const ast = fromJSON({ v: 1, root: { type: 'op', op: 'unaryMinus', args: [null] } }) as OperatorNode;
    expect(ast.args).toHaveLength(1);
    expect(isEvaluable(ast)).toBe(false);
  });
});

describe('fromJSON rejects n-ary pow chains (no unambiguous association)', () => {
  it('rejects a three-arg pow chain with a typed validation error', () => {
    // Decision within the decided boundary: reject, not right-fold. The fold
    // is left-associative but every mathjs user types right-associative
    // (`2^3^4` = 2^(3^4) ≈ 2.4e24, not (2^3)^4 = 4096) — a 21-orders-of-
    // magnitude divergence. No editor path produces this shape.
    const root = {
      type: 'op',
      op: 'pow',
      args: [{ type: 'num', value: 2 }, { type: 'num', value: 3 }, { type: 'num', value: 4 }],
    };
    expect(() => fromJSON({ v: 1, root })).toThrow(ValidationError);
    expect(() => fromJSON({ v: 1, root })).toThrow(/unambiguous association/);
  });

  it('keeps the two-arg pow op legal and left-folded (identical to the typed binary form)', () => {
    const ast = fromJSON({
      v: 1,
      root: { type: 'op', op: 'pow', args: [{ type: 'num', value: 2 }, { type: 'num', value: 3 }] },
    }) as OperatorNode;
    expect(ast.toMathNode().evaluate()).toBe(8);
    expect(fromJSON(JSON.parse(JSON.stringify(toJSON(ast))))).toEqual(ast);
  });

  it('keeps an incomplete pow (one filled slot + one empty slot) legal', () => {
    const ast = fromJSON({
      v: 1,
      root: { type: 'op', op: 'pow', args: [{ type: 'num', value: 2 }, null] },
    }) as OperatorNode;
    expect(isEvaluable(ast)).toBe(false);
  });
});

describe('subscript name identity cannot be forged (label channel integrity)', () => {
  it('rejects _ in the base label', () => {
    // sub(x_y, z) and sub(x, y_z) both projected to x_y_z — name forgery.
    expect(() => fromJSON({ v: 1, root: { type: 'sub', base: 'x_y', sub: 'z' } })).toThrow(ValidationError);
  });

  it('rejects _ in the sub label', () => {
    expect(() => fromJSON({ v: 1, root: { type: 'sub', base: 'x', sub: 'y_z' } })).toThrow(ValidationError);
  });

  it.each([
    ['operator syntax in the base', 'a+b', 'c'],
    ['parenthesis syntax in the base', 'a) or (b', 'c'],
    ['whitespace in the base', 'a b', 'c'],
    ['digit-leading base (would tokenize as a product)', '2x', 'c'],
  ])('rejects %s', (_label, base, sub) => {
    // Unvalidated labels projected to SymbolNode names whose display form
    // re-parses to a different tree than the fold evaluates.
    expect(() => fromJSON({ v: 1, root: { type: 'sub', base, sub } })).toThrow(ValidationError);
  });

  it.each([
    ['plain labels', 'x', 'max'],
    ['digits in the sub label', 'x', '2'],
    ['unicode labels', 'σ', 'max'],
    ['digits after a letter in the base', 'x2', 'max'],
  ])('accepts %s', (_label, base, sub) => {
    const ast = fromJSON({ v: 1, root: { type: 'sub', base, sub } }) as SubscriptNode;
    expect(ast.toMathNode()).toBeDefined();
  });

  it('the label projection is injective: distinct legal pairs, distinct names', () => {
    const pairs: [string, string][] = [
      ['x', 'max'], ['x', 'min'], ['xmax', 'a'], ['y', 'max'], ['a', 'b1'], ['a1', 'b'], ['σ', '2'],
    ];
    const names = pairs.map(([base, sub]) => (new SubscriptNode(base, sub) as SubscriptNode).toMathNode());
    expect(new Set(names.map((n) => (n as { name: string }).name)).size).toBe(pairs.length);
    // The single separator splits back to the original pair — no two stored
    // trees can share one projected name.
    for (const [base, sub] of pairs) {
      const name = (new SubscriptNode(base, sub).toMathNode() as { name: string }).name;
      const [b, s] = name.split('_');
      expect([b, s]).toEqual([base, sub]);
    }
  });

  it('keeps empty labels legal (incomplete tree)', () => {
    const ast = fromJSON({ v: 1, root: { type: 'sub', base: '', sub: '' } }) as SubscriptNode;
    expect(isEvaluable(ast)).toBe(false);
  });
});

describe('custom-vocabulary contract (format gate, no silent default fallback)', () => {
  it('rejects a vocabulary listing a compound unit string', () => {
    // 'm/s' cannot survive the frozen SymbolNode projection; listing it as
    // host data used to make it a first-class unit whose fold throws.
    const hostVocab: StaticVocabulary = { constants: [], units: ['m/s'], functions: [] };
    expect(() => fromJSON(unitEnvelope('m/s'), hostVocab)).toThrow(ValidationError);
  });

  it('rejects a vocabulary listing a parser-shadowed name as a unit', () => {
    // The expression parser resolves 'min' as the function first; a UnitNode
    // carrying it would pass validation and throw at evaluation.
    const hostVocab: StaticVocabulary = { constants: [], units: ['mm', 'min'], functions: [] };
    expect(() => fromJSON(unitEnvelope('mm'), hostVocab)).toThrow(/function or constant/);
  });

  it('accepts an identifier-shaped unknown string on host authority', () => {
    // Undecidable at this layer: 'banana' is indistinguishable from a unit
    // the host defined in its own mathjs instance (createUnit). Well-formed
    // unknown strings are the host's declaration; evaluation agreement is
    // the host's createUnit responsibility.
    const loose: StaticVocabulary = { constants: [], units: ['banana'], functions: [] };
    const ast = fromJSON(unitEnvelope('banana'), loose) as UnitNode;
    expect(isEvaluable(ast)).toBe(true);
  });

  it('a provided vocabulary with units omitted means no units (no default fallback)', () => {
    const noUnits = { constants: [], functions: [] } as StaticVocabulary;
    expect(() => fromJSON(unitEnvelope('mm'), noUnits)).toThrow(/not a unit in the vocabulary/);
  });

  it('a custom unit list fully replaces the default gate', () => {
    const custom: StaticVocabulary = { constants: [], units: ['widgets'], functions: [] };
    expect(fromJSON(unitEnvelope('widgets'), custom)).toBeInstanceOf(UnitNode);
    expect(() => fromJSON(unitEnvelope('mm'), custom)).toThrow(/not a unit in the vocabulary/);
  });

  it('rejects a vocabulary entry that is not a string at all', () => {
    const sloppy = { constants: [], units: [42], functions: [] } as unknown as StaticVocabulary;
    expect(() => fromJSON(unitEnvelope('mm'), sloppy)).toThrow(ValidationError);
  });
});

describe('fromJSON structural budgets (typed limit errors, never stack-overflow crashes)', () => {
  const deepGroups = (n: number) => {
    let root: Record<string, unknown> = { type: 'num', value: 1 };
    for (let i = 0; i < n; i += 1) root = { type: 'group', parens: 'always', child: root };
    return { v: 1 as const, root };
  };

  it('exports the budgets and the typed limit error class', () => {
    expect(AST_LIMITS.maxDepth).toBeGreaterThan(0);
    expect(AST_LIMITS.maxNodes).toBeGreaterThan(0);
    const err = new ValidationLimitError('maxDepth', AST_LIMITS.maxDepth, 'test');
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.kind).toBe('maxDepth');
  });

  it('rejects a 10,000-deep envelope with a typed depth error, not a RangeError', () => {
    // A ~50 KB deep envelope used to kill fromJSON with an uncontrolled
    // RangeError (stack overflow) — a crash, not a validation error.
    let error: unknown;
    try {
      fromJSON(deepGroups(10_000));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationLimitError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as ValidationLimitError).kind).toBe('maxDepth');
    expect((error as ValidationLimitError).limit).toBe(AST_LIMITS.maxDepth);
  });

  it('rejects a 1,000,000-deep envelope the same way (iterative pre-pass)', () => {
    expect(() => fromJSON(deepGroups(1_000_000))).toThrow(ValidationLimitError);
  });

  it('accepts an envelope at exactly the depth budget and evaluates it', () => {
    const ast = fromJSON(deepGroups(AST_LIMITS.maxDepth - 1))!;
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate()).toBe(1);
  });

  it('rejects one level past the depth budget', () => {
    expect(() => fromJSON(deepGroups(AST_LIMITS.maxDepth))).toThrow(ValidationLimitError);
  });

  it('rejects a 300,000-arg op chain with a typed node-count error', () => {
    // The chain used to be accepted and fold into a binary chain whose
    // evaluation died with a mathjs-internal RangeError — the layer emitted
    // a tree its own evaluation engine cannot evaluate.
    const args = Array.from({ length: 300_000 }, () => ({ type: 'num', value: 1 }));
    let error: unknown;
    try {
      fromJSON({ v: 1, root: { type: 'op', op: 'add', args } });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationLimitError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as ValidationLimitError).kind).toBe('maxNodes');
  });

  it('accepts an envelope at exactly the node budget and evaluates the fold', () => {
    // A wide-but-legal chain folds to a binary chain as deep as its arg
    // count; the budget keeps that depth inside what mathjs evaluate can
    // walk (measured crash point of the evaluation engine: 1500–2000).
    const args = Array.from({ length: AST_LIMITS.maxNodes - 1 }, () => ({ type: 'num', value: 1 }));
    const ast = fromJSON({ v: 1, root: { type: 'op', op: 'add', args } }) as OperatorNode;
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate()).toBe(AST_LIMITS.maxNodes - 1);
  });

  it('rejects one node past the node-count budget', () => {
    const args = Array.from({ length: AST_LIMITS.maxNodes }, () => ({ type: 'num', value: 1 }));
    expect(() => fromJSON({ v: 1, root: { type: 'op', op: 'add', args } })).toThrow(ValidationLimitError);
  });
});
