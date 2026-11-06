// Operator swap (arc session 4): entry positions, swap kinds (higher-prec
// wrap, lower-prec left/right/mid splits, equal-prec ties, ×↔÷ parent-split,
// ^ swaps, binary rename), the consecutive-changed flat merge, junction
// carets, same-op byte-identical no-ops, one-swap-one-op undo round-trips,
// barriers (frac/group), and the rejections left behind by session 3 outside
// swap territory. The insertion-vs-swap oracle lives in swap-oracle.test.ts.

import { describe, expect, it } from 'vitest';
import { fromJSON, type NodeJson } from '../src/ast/index.js';
import {
  EngineError,
  applyOp,
  caretResolves,
  envelopeOf,
  initSession,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type TypedToken,
} from '../src/engine/index.js';
import { typeSource } from './typing-support.js';

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

const M = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'multiply', args });
const A = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'add', args });
const S = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'subtract', args });
const F = (a: NodeJson | null, b: NodeJson | null): NodeJson => ({ type: 'frac', num: a, den: b });
const PW = (a: NodeJson | null, b: NodeJson | null): NodeJson => ({ type: 'pow', base: a, exp: b });
const G = (child: NodeJson | null): NodeJson => ({ type: 'group', parens: 'always', child });

/** Type a source, then park the caret at an explicit position. */
const typedAt = (source: string, to: Caret): EditingState =>
  applyOp(typeSource(source), { op: 'moveCaret', to });

const rootOf = (state: EditingState): NodeJson | null => envelopeOf(state).root;
const parsed = (state: EditingState): unknown => JSON.parse(JSON.stringify(rootOf(state)));
const settle = (state: EditingState): string => JSON.stringify([envelopeOf(state), state.caret, state.log.length]);

/** Swap `token` in a typed source at `pos`, asserting the exact result tree
 *  and junction caret, one new log entry, a swap op in the log, undo
 *  byte-exactness, and contract legality + caret validity at the state. */
function expectSwap(
  source: string,
  pos: Caret,
  token: TypedToken,
  root: unknown,
  caret: Caret,
): EditingState {
  const before = typedAt(source, pos);
  const beforeSnapshot = settle(before);
  const after = typeToken(before, token);
  expect(parsed(after)).toEqual(root);
  expect(after.caret).toEqual(caret);
  expect(after.log.length).toBe(before.log.length + 1);
  expect(after.log[after.log.length - 1].op.op).toBe('swap');
  expect(() => fromJSON(envelopeOf(after))).not.toThrow();
  expect(caretResolves(fromJSON(envelopeOf(after)), after.caret)).toBe(true);
  const back = undo(after);
  expect(settle(back)).toBe(beforeSnapshot);
  return after;
}

/** The byte-identical no-op: the same operator retyped. */
function expectNoop(source: string, pos: Caret, token: TypedToken): void {
  const state = typedAt(source, pos);
  const before = settle(state);
  const after = typeToken(state, token);
  expect(settle(after)).toBe(before);
}

function expectRejectAt(source: string, pos: Caret, token: TypedToken, code = 'not-a-typing-point'): void {
  const state = typedAt(source, pos);
  const before = settle(state);
  let threw: unknown;
  try {
    typeToken(state, token);
  } catch (error) {
    threw = error;
  }
  expect(threw).toBeInstanceOf(EngineError);
  expect((threw as { code?: string }).code).toBe(code);
  expect(settle(state)).toBe(before);
}

// ——— Entry positions: seam and mid-row node carets address the operator ———

describe('swap entry positions (row seam and mid-row node, symmetric)', () => {
  it('seam carets and node carets address the same operator — 5-2-1 first −→× wraps (5,2)', () => {
    for (const pos of [{ kind: 'row', path: [], index: 1 } as const, { kind: 'node', path: [0] } as const]) {
      expectSwap('5-2-1', pos, tok.times, S(M(num(5), num(2)), num(1)), { kind: 'row', path: [0], index: 1 });
    }
  });

  it('the second −→× swaps (2,1): 5-2-1 from seam 2 / node-on-2', () => {
    for (const pos of [{ kind: 'row', path: [], index: 2 } as const, { kind: 'node', path: [1] } as const]) {
      expectSwap('5-2-1', pos, tok.times, S(num(5), M(num(2), num(1))), { kind: 'row', path: [1], index: 1 });
    }
  });

  it('retyping the row operator at any operator position is a byte-identical no-op', () => {
    for (const pos of [
      { kind: 'row', path: [], index: 1 } as const,
      { kind: 'row', path: [], index: 2 } as const,
      { kind: 'node', path: [0] } as const,
      { kind: 'node', path: [1] } as const,
    ]) {
      expectNoop('5-2-1', pos, tok.minus);
    }
  });

  it('one swap = one visible edit: a multi-swap flow undoes back byte-exactly', () => {
    let state: EditingState = typedAt('5-2-1', { kind: 'row', path: [], index: 1 });
    const baseline = settle(state);
    state = typeToken(state, tok.times); // first − → ×
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: [0] } });
    state = typeToken(state, tok.times); // the remaining − → × merges flat
    expect(parsed(state)).toEqual(M(num(5), num(2), num(1)));
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 2 });
    // Ctrl-Z steps back exactly one visible edit at a time, to the baseline.
    let cur = state;
    while (settle(cur) !== baseline) cur = undo(cur);
    expect(settle(cur)).toBe(baseline);
  });
});

// ——— Swap kinds, pinned from realistic typed states ———

describe('swap kinds (higher wrap / lower splits / ties / ÷ and ^ / binary rename)', () => {
  it('higher-prec wrap pins the verified example; a wrong-side wrap is a red shape', () => {
    const after = typeToken(typedAt('5-2-1', { kind: 'row', path: [], index: 1 }), tok.times);
    expect(parsed(after)).toEqual(S(M(num(5), num(2)), num(1)));
    // The wrapped pair is (5,2) — the operands the changed operator binds —
    // never the wrong side (5 bare, 2-1 wrapped).
    expect(parsed(after)).not.toEqual(S(num(5), M(num(2), num(1))));
  });

  it('higher-prec wrap to ^ and ÷: the bound pair becomes pow / frac in place', () => {
    expectSwap('a+b+c', { kind: 'row', path: [], index: 1 }, tok.pow, A(PW(sym('a'), sym('b')), sym('c')), {
      kind: 'node',
      path: [0],
    });
    expectSwap('a+b+c', { kind: 'row', path: [], index: 1 }, tok.divide, A(F(sym('a'), sym('b')), sym('c')), {
      kind: 'node',
      path: [0],
    });
  });

  it('lower-prec LEFT split (verified example): 2*3*4 first ×→+  →  op[add][2, op[multiply][3,4]]', () => {
    expectSwap('2*3*4', { kind: 'row', path: [], index: 1 }, tok.plus, A(num(2), M(num(3), num(4))), {
      kind: 'row',
      path: [],
      index: 1,
    });
  });

  it('lower-prec RIGHT split (no asymmetry): 2*3*4 last ×→+  →  op[add][op[multiply][2,3], 4]', () => {
    expectSwap('2*3*4', { kind: 'row', path: [], index: 2 }, tok.plus, A(M(num(2), num(3)), num(4)), {
      kind: 'row',
      path: [],
      index: 1,
    });
  });

  it('lower-prec MID split: 2*3*4*5, middle ×→+ keeps both runs grouped', () => {
    expectSwap(
      '2*3*4*5',
      { kind: 'row', path: [], index: 2 },
      tok.plus,
      A(M(num(2), num(3)), M(num(4), num(5))),
      { kind: 'row', path: [], index: 1 },
    );
  });

  it('equal-precedence tie re-binds like typing (left-associative): a-b-c first −→+ = a+b-c', () => {
    // ((a+b)-c), not the CAS-style a+(b-c) — the structural tie pin.
    expectSwap('a-b-c', { kind: 'row', path: [], index: 1 }, tok.plus, S(A(sym('a'), sym('b')), sym('c')), {
      kind: 'row',
      path: [0],
      index: 1,
    });
    const after = typeToken(typedAt('a-b-c', { kind: 'row', path: [], index: 1 }), tok.plus);
    expect(parsed(after)).not.toEqual(A(sym('a'), S(sym('b'), sym('c'))));
  });

  it('×↔÷ parent-split with ÷ binary (pinned edge rule), both directions', () => {
    // First ×→÷: like typed 2/3*4 — the frac takes only the left operand.
    expectSwap('2*3*4', { kind: 'row', path: [], index: 1 }, tok.divide, M(F(num(2), num(3)), num(4)), {
      kind: 'node',
      path: [0],
    });
    // Last ×→÷: like typed 2*3/4 — the left run groups under the numerator.
    expectSwap('2*3*4', { kind: 'row', path: [], index: 2 }, tok.divide, F(M(num(2), num(3)), num(4)), {
      kind: 'node',
      path: [],
    });
  });

  it('÷ never flattens into a row: 2*3*4*5 first ×→÷ keeps 4 and 5 in the multiply row', () => {
    expectSwap(
      '2*3*4*5',
      { kind: 'row', path: [], index: 1 },
      tok.divide,
      M(F(num(2), num(3)), num(4), num(5)),
      { kind: 'node', path: [0] },
    );
  });

  it('pow swap: 2*3*4 first ×→^ equals typed 2^3*4', () => {
    expectSwap('2*3*4', { kind: 'row', path: [], index: 1 }, tok.pow, M(PW(num(2), num(3)), num(4)), {
      kind: 'node',
      path: [0],
    });
  });

  it('binary chain swap is a plain operator rename: 5-2 −→× = 5*2', () => {
    expectSwap('5-2', { kind: 'row', path: [], index: 1 }, tok.times, M(num(5), num(2)), {
      kind: 'row',
      path: [],
      index: 1,
    });
  });

  it('incomplete chains swap too: 5- on-5 −→× = 5*, the junction is the pending cell', () => {
    const after = typeToken(typedAt('5-', { kind: 'node', path: [0] }), tok.times);
    expect(parsed(after)).toEqual(M(num(5), null));
    expect(after.caret).toEqual({ kind: 'row', path: [], index: 1 });
    const filled = typeToken(after, leaf(num(2)));
    expect(parsed(filled)).toEqual(parsed(typeSource('5*2')));
  });
});

// ——— Consecutive changed operators merge into one flat node ———

describe('consecutive changed ops merge flat (equal-precedence edge rule)', () => {
  it('5-2-1: both −→× in sequence collapse to multiply[5,2,1] — the subtract row merges away', () => {
    let state: EditingState = typedAt('5-2-1', { kind: 'node', path: [0] });
    state = typeToken(state, tok.times);
    expect(parsed(state)).toEqual(S(M(num(5), num(2)), num(1)));
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: [0] } });
    state = typeToken(state, tok.times);
    expect(parsed(state)).toEqual(parsed(typeSource('5*2*1')));
  });

  it('nested row: a+2*3+d, the ×→+ re-folds through the parent: flat add[a,2,3,d]', () => {
    expectSwap('a+2*3+d', { kind: 'row', path: [1], index: 1 }, tok.plus, A(sym('a'), num(2), num(3), sym('d')), {
      kind: 'row',
      path: [],
      index: 2,
    });
  });

  it('barriers hold: the swap inside a group numerator stays inside the group', () => {
    // (2*3)*4 — the × inside the group swaps; the group wrapper survives.
    expectSwap(
      '(2*3)*4',
      { kind: 'row', path: [0, 'child'], index: 1 },
      tok.plus,
      M(G(A(num(2), num(3))), num(4)),
      { kind: 'row', path: [0, 'child'], index: 1 },
    );
  });

  it('frac numerator barrier: the swapped numerator re-folds inside the slot', () => {
    // 2*3/4 — the × inside frac.num swaps to +; den untouched.
    expectSwap('2*3/4', { kind: 'row', path: ['num'], index: 1 }, tok.plus, F(A(num(2), num(3)), num(4)), {
      kind: 'row',
      path: ['num'],
      index: 1,
    });
  });
});

// ——— Rejections: swap territory ends where session 3 left it ———

describe('rejections and unchanged positions (outside swap territory)', () => {
  it('the end seam and seam 0 address no operator — typed rejection, nothing logged', () => {
    expectRejectAt('a+b+c', { kind: 'row', path: [], index: 3 }, tok.times);
    expectRejectAt('a+b+c', { kind: 'row', path: [], index: 0 }, tok.times);
  });

  it('the last arg is a hold, not a swap: typing at node-on-last extends (session 3)', () => {
    const after = typeToken(typedAt('a+b+c', { kind: 'node', path: [2] }), tok.plus);
    expect(parsed(after)).toEqual(A(sym('a'), sym('b'), sym('c'), null));
    expect(after.caret).toEqual({ kind: 'row', path: [], index: 3 });
  });

  it('null args cells keep fill semantics: × over a pending cell rejects (no unary form)', () => {
    expectRejectAt('a+', { kind: 'row', path: [], index: 1 }, tok.times);
  });

  it('unknown-op rows are not swap territory: bitOr chains reject at every position', () => {
    const at = (pos: Caret): EditingState => {
      const seeded = initSession({ v: 1, root: { type: 'op', op: 'bitOr', args: [sym('a'), sym('b'), sym('c')] } });
      return applyOp(seeded, { op: 'moveCaret', to: pos });
    };
    for (const pos of [{ kind: 'row', path: [], index: 1 } as const, { kind: 'node', path: [1] } as const]) {
      const state = at(pos);
      let threw: unknown;
      try {
        typeToken(state, tok.times);
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(EngineError);
      expect((threw as { code?: string }).code).toBe('not-a-typing-point');
    }
  });

  it('operator-expected semantics stay: − at a pending cell is a unary attach, not a swap', () => {
    const before = typedAt('a+', { kind: 'row', path: [], index: 1 });
    const after = typeToken(before, tok.minus);
    expect(parsed(after)).toEqual(A(sym('a'), { type: 'op', op: 'unaryMinus', args: [null] }));
    expect(after.log.length).toBe(before.log.length + 1);
  });

  it('group tokens and leaves at operator positions keep the typed rejection', () => {
    expectRejectAt('a+b+c', { kind: 'row', path: [], index: 1 }, tok.open);
    expectRejectAt('a+b+c', { kind: 'row', path: [], index: 1 }, tok.close);
    expectRejectAt('a+b+c', { kind: 'row', path: [], index: 1 }, leaf(sym('z')));
  });
});
