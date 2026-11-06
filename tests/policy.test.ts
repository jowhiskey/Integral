// Insertion policy (arc session 3): precedence-table pins against mathjs,
// attach-rule pins from realistic typed states, typing-point rejections,
// caret placement per attach kind, one-op emission + legality, and undo
// round-trips. The mathjs typing oracle lives in typing-oracle.test.ts.

import { describe, expect, it } from 'vitest';
import { parse, type MathNode as MathJsNode, type OperatorNode as MathOperatorNode } from 'mathjs';
import { fromJSON, type NodeJson } from '../src/ast/index.js';
import {
  EngineError,
  PRECEDENCE,
  applyOp,
  caretResolves,
  decideAttach,
  envelopeOf,
  initSession,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type TypedToken,
} from '../src/engine/index.js';
import { CORPUS, lex, typeSource } from './typing-support.js';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });

const tok: Record<string, TypedToken> = {
  plus: { t: 'operator', fn: 'add' },
  minus: { t: 'operator', fn: 'subtract' },
  times: { t: 'operator', fn: 'multiply' },
  modulo: { t: 'operator', fn: 'mod' },
  divide: { t: 'divide' },
  pow: { t: 'pow' },
  open: { t: 'groupOpen' },
  close: { t: 'groupClose' },
};
const leaf = (node: NodeJson): TypedToken => ({ t: 'leaf', node });
const n = (v: number): TypedToken => leaf(num(v));
const s = (name: string): TypedToken => leaf(sym(name));

/** Type a token sequence from the empty formula. */
const typeSeq = (tokens: readonly TypedToken[]): EditingState => {
  let state = initSession();
  for (const t of tokens) state = typeToken(state, t);
  return state;
};

/** A seeded session with the caret placed (host-style moveCaret). */
const seedAt = (seed: unknown, to: Caret): EditingState => applyOp(initSession(seed), { op: 'moveCaret', to });

const expectReject = (state: EditingState, token: TypedToken, code = 'not-a-typing-point'): void => {
  const before = JSON.stringify([envelopeOf(state), state.caret, state.log.length]);
  let threw: unknown;
  try {
    typeToken(state, token);
  } catch (error) {
    threw = error;
  }
  expect(threw).toBeInstanceOf(EngineError);
  expect((threw as { code?: string }).code).toBe(code);
  expect(JSON.stringify([envelopeOf(state), state.caret, state.log.length])).toBe(before);
};

const treeOf = (state: EditingState): string => JSON.stringify(envelopeOf(state));
const parsed = (state: EditingState): { v: number; root: NodeJson } => JSON.parse(treeOf(state));

// ——— Precedence table ↔ mathjs ———

describe('precedence table agrees with mathjs binding behavior', () => {
  const BINARY = [
    { fn: 'add', src: '+' },
    { fn: 'subtract', src: '-' },
    { fn: 'multiply', src: '*' },
    { fn: 'divide', src: '/' },
    { fn: 'mod', src: 'mod' },
    { fn: 'pow', src: '^' },
  ] as const;

  const rootFn = (node: MathJsNode): string | null =>
    node.type === 'OperatorNode' ? (node as MathOperatorNode).fn : null;

  it('every interacting operator pair — one probe per pair, matches the table order', () => {
    for (const A of BINARY) {
      for (const B of BINARY) {
        if (A.fn === B.fn) continue;
        const root = rootFn(parse(`2 ${A.src} 3 ${B.src} 4`));
        // root A (B nested in A's operands): B binds tighter than A.
        // root B (A's binding nested as B's left operand): B binds looser
        // or equal — the pair probes resolve <, >, and = in both directions.
        expect(PRECEDENCE[B.fn].prec > PRECEDENCE[A.fn].prec).toBe(root === A.fn);
        expect(PRECEDENCE[B.fn].prec <= PRECEDENCE[A.fn].prec).toBe(root === B.fn);
      }
    }
  });

  it('same-operator associativity probes `2 A 3 A 4` — one pin per row', () => {
    for (const A of BINARY) {
      const tree = parse(`2 ${A.src} 3 ${A.src} 4`) as MathOperatorNode;
      const left = tree.args[0] as MathJsNode;
      const leftNested = left.type === 'OperatorNode' && (left as MathOperatorNode).fn === tree.fn;
      expect(PRECEDENCE[A.fn].assoc === 'left').toBe(leftNested);
    }
  });

  it('unary precedence pins: pow binds tighter than unary minus, unary tighter than multiply', () => {
    const negPow = parse('-2^2') as MathOperatorNode;
    expect(negPow.fn).toBe('unaryMinus');
    expect((negPow.args[0] as MathOperatorNode).fn).toBe('pow');
    expect(PRECEDENCE.pow.prec).toBeGreaterThan(PRECEDENCE.unaryMinus.prec);

    const negMul = parse('-2*3') as MathOperatorNode;
    expect(negMul.fn).toBe('multiply');
    expect((negMul.args[0] as MathOperatorNode).fn).toBe('unaryMinus');
    expect(PRECEDENCE.unaryMinus.prec).toBeGreaterThan(PRECEDENCE.multiply.prec);
  });

  it('position pins: minus is unary exactly where mathjs parses it unary', () => {
    const containsUnaryMinus = (source: string): boolean => {
      const walk = (node: MathJsNode): boolean => {
        if (node.type === 'OperatorNode' && (node as MathOperatorNode).fn === 'unaryMinus') return true;
        if (node.type === 'ParenthesisNode') return walk((node as unknown as { content: MathJsNode }).content);
        const args = (node as { args?: MathJsNode[] }).args;
        return args !== undefined ? args.some(walk) : false;
      };
      return walk(parse(source));
    };
    for (const unaryAt of ['-2', '2*-3', '2--3', '2+-3', '2^-3', '(-2)']) {
      expect(containsUnaryMinus(unaryAt), unaryAt).toBe(true);
    }
    for (const binaryAt of ['2-3', '2+3', '2^3', '2*3', '2 mod 3']) {
      expect(containsUnaryMinus(binaryAt), binaryAt).toBe(false);
    }
  });
});

// ——— Attach-rule pins ———

describe('attach-rule pins (wrap / nest / group / chain-extend / chain-wrap / chain-nest)', () => {
  it('wrap: a token after a value — 5+ becomes op[add](5, null), caret in the pending cell', () => {
    const state = typeSeq([n(5), tok.plus]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'op', op: 'add', args: [num(5), null] },
    });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
  });

  it('nest: higher precedence nests in the context right operand — a+b* stays one add row', () => {
    const state = typeSeq([s('a'), tok.plus, s('b'), tok.times]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [sym('a'), { type: 'op', op: 'multiply', args: [sym('b'), null] }],
      },
    });
    expect(state.caret).toEqual({ kind: 'row', path: [1], index: 1 });
  });

  it('group: user parens create a GroupNode; close pops the caret onto it; typing then wraps outside', () => {
    let state = typeSeq([tok.open, s('a'), tok.plus, s('b'), tok.close]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'group',
        parens: 'always',
        child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] },
      },
    });
    expect(state.caret).toEqual({ kind: 'node', path: [] });
    state = typeToken(state, tok.times);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'multiply',
        args: [
          { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
          null,
        ],
      },
    });
  });

  it('group-open over a typed value wraps it (juxtaposition is unrepresentable)', () => {
    const state = typeSeq([s('a'), tok.plus, s('b'), tok.open]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [sym('a'), { type: 'group', parens: 'always', child: sym('b') }],
      },
    });
  });

  it('chain-extend: same-op token at the chain boundary stays flat — a+b+', () => {
    const state = typeSeq([s('a'), tok.plus, s('b'), tok.plus]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), null] },
    });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 2 });
  });

  it('chain-wrap: lower precedence token at the chain end wraps the whole chain — a*b*c+', () => {
    let state = typeSeq([s('a'), tok.times, s('b'), tok.times, s('c')]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'op', op: 'multiply', args: [sym('a'), sym('b'), sym('c')] },
    });
    state = typeToken(state, tok.plus);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [{ type: 'op', op: 'multiply', args: [sym('a'), sym('b'), sym('c')] }, null],
      },
    });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
  });

  it('chain-nest: higher precedence at the chain end nests in the rightmost operand — a+b^', () => {
    const state = typeSeq([s('a'), tok.plus, s('b'), tok.pow]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('a'), { type: 'pow', base: sym('b'), exp: null }] },
    });
    expect(state.caret).toEqual({ kind: 'slot', path: [1], slot: 'exp' });
  });

  it('equal precedence, different operator climbs: a-b+ becomes add(subtract(a,b), …)', () => {
    const state = typeSeq([s('a'), tok.minus, s('b'), tok.plus]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [{ type: 'op', op: 'subtract', args: [sym('a'), sym('b')] }, null],
      },
    });
  });

  it('same-op binary after a complete chain extends it: a-b- stays one subtract row', () => {
    const state = typeSeq([s('a'), tok.minus, s('b'), tok.minus]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'op', op: 'subtract', args: [sym('a'), sym('b'), null] },
    });
  });

  it('divide and pow build their structures: / and ^ wrap the candidate in frac/pow', () => {
    const div = typeSeq([s('a'), tok.divide]);
    expect(parsed(div)).toEqual({ v: 1, root: { type: 'frac', num: sym('a'), den: null } });
    expect(div.caret).toEqual({ kind: 'slot', path: [], slot: 'den' });
    const pw = typeSeq([s('a'), tok.pow]);
    expect(parsed(pw)).toEqual({ v: 1, root: { type: 'pow', base: sym('a'), exp: null } });
    expect(pw.caret).toEqual({ kind: 'slot', path: [], slot: 'exp' });
  });

  it('pow into pow nests (right-associative): a^b^ becomes a^(b^…)', () => {
    let state = typeSeq([s('a'), tok.pow, s('b'), tok.pow]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'pow', base: sym('a'), exp: { type: 'pow', base: sym('b'), exp: null } },
    });
    expect(state.caret).toEqual({ kind: 'slot', path: ['exp'], slot: 'exp' });
    state = typeToken(state, s('c'));
    expect(parsed(state)).toEqual({
      v: 1,
      root: { type: 'pow', base: sym('a'), exp: { type: 'pow', base: sym('b'), exp: sym('c') } },
    });
  });

  it('unary attach: − at an operand-expected position is unaryMinus — a+- becomes add(a, unary(□))', () => {
    let state = typeSeq([s('a'), tok.plus, tok.minus]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [sym('a'), { type: 'op', op: 'unaryMinus', args: [null] }],
      },
    });
    state = typeToken(state, s('b'));
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'op',
        op: 'add',
        args: [sym('a'), { type: 'op', op: 'unaryMinus', args: [sym('b')] }],
      },
    });
  });

  it('fresh pending cells: the operator family repeats as unary forms (a++ → add(a, unaryPlus(□)))', () => {
    const plus = typeSeq([s('a'), tok.plus, tok.plus]);
    expect((JSON.parse(treeOf(plus)).root.args[1] as NodeJson).op).toBe('unaryPlus');
    const minus = typeSeq([s('a'), tok.plus, tok.minus]);
    expect((JSON.parse(treeOf(minus)).root.args[1] as NodeJson).op).toBe('unaryMinus');
  });

  it('barriers bind nothing out: fn rows, frac numerators, radicands', () => {
    // fn row: the wrap replaces the arg cell — it never escapes the fn node
    const fnSeed = seedAt({ v: 1, root: { type: 'fn', name: 'sin', args: [sym('x')] } }, { kind: 'node', path: [0] });
    expect(parsed(typeToken(fnSeed, tok.plus))).toEqual({
      v: 1,
      root: { type: 'fn', name: 'sin', args: [{ type: 'op', op: 'add', args: [sym('x'), null] }] },
    });
    // frac numerator: climbing stops at the frac boundary (num is not den)
    const fracSeed = seedAt(
      { v: 1, root: { type: 'frac', num: { type: 'op', op: 'multiply', args: [num(2), num(3)] }, den: num(5) } },
      { kind: 'node', path: ['num', 1] },
    );
    expect(parsed(typeToken(fracSeed, tok.plus))).toEqual({
      v: 1,
      root: {
        type: 'frac',
        num: { type: 'op', op: 'add', args: [{ type: 'op', op: 'multiply', args: [num(2), num(3)] }, null] },
        den: { type: 'num', value: 5 },
      },
    });
    // radicand: a binary wrap nests inside the radicand slot
    const rootSeed = seedAt({ v: 1, root: { type: 'root', radicand: sym('x') } }, { kind: 'node', path: ['radicand'] });
    expect(parsed(typeToken(rootSeed, tok.minus))).toEqual({
      v: 1,
      root: { type: 'root', radicand: { type: 'op', op: 'subtract', args: [sym('x'), null] } },
    });
    // a subscript hold wraps like any typed value (leaf type)
    const subSeed = seedAt({ v: 1, root: { type: 'sub', base: 'x', sub: 'max' } }, { kind: 'node', path: [] });
    expect(parsed(typeToken(subSeed, tok.plus))).toEqual({
      v: 1,
      root: { type: 'op', op: 'add', args: [{ type: 'sub', base: 'x', sub: 'max' }, null] },
    });
    // a unit's value continues inside the unit (value slot is a barrier)
    const unitSeed = seedAt({ v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } }, { kind: 'node', path: ['value'] });
    expect(parsed(typeToken(unitSeed, tok.minus))).toEqual({
      v: 1,
      root: { type: 'unit', value: { type: 'op', op: 'subtract', args: [num(50), null] }, unit: 'mm' },
    });
  });

  it('group-close: unbalanced ")" is a defined no-op — nothing logged, state byte-identical', () => {
    const state = typeSeq([s('a'), tok.plus, s('b')]);
    const before = JSON.stringify([treeOf(state), state.caret, state.log.length]);
    const after = typeToken(state, tok.close);
    expect(JSON.stringify([treeOf(after), after.caret, after.log.length])).toBe(before);
  });

  it('group-close: one pop per ")" — nested groups close level by level', () => {
    let state = typeSeq([tok.open, tok.open, s('a'), tok.minus, s('b'), tok.close]);
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'group',
        parens: 'always',
        child: {
          type: 'group',
          parens: 'always',
          child: { type: 'op', op: 'subtract', args: [sym('a'), sym('b')] },
        },
      },
    });
    // after the first close the caret sits on the inner group; the outer
    // is still the root (closed by a second token below).
    expect(state.caret).toEqual({ kind: 'node', path: ['child'] });
    state = typeToken(state, tok.close);
    expect(state.caret).toEqual({ kind: 'node', path: [] });
    expect(parsed(state)).toEqual({
      v: 1,
      root: {
        type: 'group',
        parens: 'always',
        child: {
          type: 'group',
          parens: 'always',
          child: { type: 'op', op: 'subtract', args: [sym('a'), sym('b')] },
        },
      },
    });
  });
});

// ——— Typing points: supported classes and typed rejections ———

describe('typing-point classes', () => {
  it('empty formula, empty fixed slot, null args cell, node on content are typing points', () => {
    expect(decideAttach({ v: 1, root: null }, { kind: 'empty' }, tok.minus).kind).toBe('unary');
    const denSeed = initSession({ v: 1, root: { type: 'frac', num: num(1), den: null } });
    expect(decideAttach(envelopeOf(denSeed), { kind: 'slot', path: [], slot: 'den' }, tok.minus).kind).toBe('unary');
    const cellSeed = initSession({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null] } });
    expect(decideAttach(envelopeOf(cellSeed), { kind: 'row', path: [], index: 1 }, tok.minus).kind).toBe('unary');
    expect(decideAttach({ v: 1, root: sym('a') }, { kind: 'node', path: [] }, tok.plus).kind).toBe('wrap');
  });

  it('a node caret on a container with an empty cell types into that cell (attach → dive → fill)', () => {
    const state = seedAt({ v: 1, root: { type: 'op', op: 'unaryMinus', args: [null] } }, { kind: 'node', path: [] });
    expect(state.caret).toEqual({ kind: 'node', path: [] });
    const after = typeToken(state, s('x'));
    expect(parsed(after)).toEqual({ v: 1, root: { type: 'op', op: 'unaryMinus', args: [sym('x')] } });
  });

  it('row seams are not typing points (end seam and splice-before-node reject, nothing logged)', () => {
    const chain = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } };
    expectReject(seedAt(chain, { kind: 'row', path: [], index: 3 }), tok.times);
    expectReject(seedAt(chain, { kind: 'row', path: [], index: 1 }), tok.times);
  });

  it('mid-row nodes and node-before-pending-cells are not typing points', () => {
    const midRow = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } };
    expectReject(seedAt(midRow, { kind: 'node', path: [1] }), tok.plus);
    const pending = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null] } };
    expectReject(seedAt(pending, { kind: 'node', path: [0] }), tok.plus);
  });

  it('multiply and mod have no unary form: they reject at operand-expected positions', () => {
    expectReject(initSession(), tok.times);
    expectReject(initSession(), tok.modulo);
    const denSeed = initSession({ v: 1, root: { type: 'frac', num: num(1), den: null } });
    expectReject(denSeed, tok.times);
  });

  it('divide and pow templates attach at operand-expected positions with both slots blank', () => {
    expect(decideAttach({ v: 1, root: null }, { kind: 'empty' }, tok.divide).kind).toBe('template');
    expect(decideAttach({ v: 1, root: null }, { kind: 'empty' }, tok.pow).kind).toBe('template');
    expect(parsed(typeSeq([tok.divide]))).toEqual({ v: 1, root: { type: 'frac', num: null, den: null } });
    expect(parsed(typeSeq([tok.pow]))).toEqual({ v: 1, root: { type: 'pow', base: null, exp: null } });
  });

  it('decideAttach is pure: envelope and caret are unchanged by consultation', () => {
    const env = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };
    const before = JSON.stringify(env);
    decideAttach(env, { kind: 'node', path: [1] }, tok.plus);
    expect(JSON.stringify(env)).toBe(before);
  });

  it('unknown op fns in the tree are barriers, not guesses — wrapping stays inside them', () => {
    // A host-built chain with an fn outside the table: the climb stops at
    // it; the token wraps the candidate where it sits (inside the row).
    const foreign = { v: 1, root: { type: 'op', op: 'bitOr', args: [sym('a'), sym('b')] } };
    const st = seedAt(foreign, { kind: 'node', path: [1] });
    expect(parsed(typeToken(st, tok.plus))).toEqual({
      v: 1,
      root: { type: 'op', op: 'bitOr', args: [sym('a'), { type: 'op', op: 'add', args: [sym('b'), null] }] },
    });
    expect(() => typeToken(st, tok.times)).not.toThrow();
  });
});

// ——— Undo round-trip ———

describe('undo round-trip after policy tokens', () => {
  it('every token is exactly one log entry (a full mixed realisation)', () => {
    const tokens: TypedToken[] = [
      n(2), tok.plus, n(3), tok.times, tok.open, s('a'), tok.minus, s('b'), tok.close, tok.pow,
    ];
    let state: EditingState = initSession();
    let ops = 0;
    for (const t of tokens) {
      const before = state.log.length;
      state = typeToken(state, t);
      ops += state.log.length - before;
    }
    expect(ops).toBe(tokens.length);
  });

  it('typed tokens then undos restore the seed byte-exactly (tree + caret)', () => {
    for (const seed of [
      { v: 1, root: null },
      { v: 1, root: { type: 'num', value: 42 } },
      { v: 1, root: { type: 'op', op: 'multiply', args: [sym('a'), sym('b')] } },
    ]) {
      const start = seedAt(seed, seed.root === null ? { kind: 'empty' } : { kind: 'node', path: [] });
      const baseline = start.log.length;
      const before = JSON.stringify([treeOf(start), start.caret]);
      let state = start;
      state = typeToken(state, tok.plus);
      state = typeToken(state, n(7));
      state = typeToken(state, tok.times);
      state = typeToken(state, s('c'));
      state = typeToken(state, tok.close); // no-op: closes nothing
      state = typeToken(state, tok.divide);
      expect(state.log.length).toBe(baseline + 5);
      while (state.log.length > baseline) state = undo(state);
      expect(JSON.stringify([treeOf(state), state.caret])).toBe(before);
    }
  });

  it('every corpus state undoes op-by-op back to the empty formula', () => {
    for (const source of CORPUS) {
      let state = typeSource(source);
      while (state.log.length > 0) state = undo(state);
      expect(treeOf(state)).toBe('{"v":1,"root":null}');
      expect(state.caret).toEqual({ kind: 'empty' });
    }
  });
});

// ——— Emitted legality ———

describe('emitted legality: policy states are contract-valid by construction', () => {
  it('every intermediate corpus state passes the fromJSON gate and carries a resolving caret', () => {
    for (const source of CORPUS) {
      let state: EditingState = initSession();
      for (const t of lex(source)) {
        state = typeToken(state, t);
        const env = envelopeOf(state);
        const rebuilt = fromJSON(env); // the contract gate: no throw, legal tree
        expect(caretResolves(rebuilt, state.caret)).toBe(true);
        expect(JSON.stringify(envelopeOf({ ...state, root: rebuilt }))).toBe(JSON.stringify(env));
      }
    }
  });
});
