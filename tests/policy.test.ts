// The literal typing surface (rework session 2a, T1–T6 + owner amendments):
// every pinned starting state of literal operator insertion, the
// null-cell splice, token mechanics (glue / split / digit-glue / Space),
// numbers (dot states), paren conversion (T5/T10), groups and fence
// pairing (T6/S-097), juxtaposition pairing and the widened evaluation
// rule, the mixed-multiply-row definition, silent no-ops, and the
// one-op-per-token / undo discipline. Every intermediate state is checked
// through the fromJSON gate (the contract boundary) with a resolving
// caret. The old oracle suites (typed insertion vs math.parse, swap) were
// invalidated wholesale by the rework and were deleted.

import { describe, expect, it } from 'vitest';
import { parse } from 'mathjs';
import { fromJSON, isEvaluable, toJSON, toMathML, type Envelope, type NodeJson } from '../src/ast/index.js';
import {
  applyOp,
  caretResolvesIn,
  envelopeOf,
  initSession,
  redo,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type OperatorFn,
  type TypedToken,
} from '../src/engine/index.js';

const num = (value: number, dot = false): NodeJson =>
  dot ? { type: 'num', value, dot: true } : { type: 'num', value };
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const op = (name: string, ...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: name, args });
const imp = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'multiply', args, implicit: true });
const fn = (name: string, args: (NodeJson | null)[], close = true): NodeJson =>
  close ? { type: 'fn', name, args } : { type: 'fn', name, args, close: false };
const group = (child: NodeJson | null, close = true): NodeJson =>
  close ? { type: 'group', parens: 'always', child } : { type: 'group', parens: 'always', child, close: false };
const fence = (): NodeJson => ({ type: 'fence', side: 'close' });
const frac = (n: NodeJson | null, d: NodeJson | null): NodeJson => ({ type: 'frac', num: n, den: d });
const pow = (b: NodeJson | null, e: NodeJson | null): NodeJson => ({ type: 'pow', base: b, exp: e });

const plus: TypedToken = { t: 'operator', fn: 'add' };
const minus: TypedToken = { t: 'operator', fn: 'subtract' };
const times: TypedToken = { t: 'operator', fn: 'multiply' };
const open: TypedToken = { t: 'groupOpen' };
const close: TypedToken = { t: 'groupClose' };
const comma: TypedToken = { t: 'comma' };
const dot: TypedToken = { t: 'dot' };
const space: TypedToken = { t: 'space' };
const d = (str: string): TypedToken => ({ t: 'leaf', node: { type: 'num', value: Number(str) } });
const s = (ch: string): TypedToken => ({ t: 'leaf', node: { type: 'sym', name: ch } });

const tree = (state: EditingState): NodeJson | null => envelopeOf(state).root;
const j = (x: unknown): string => JSON.stringify(x);
/** Deep-equal against the expected JSON root (byte-stable, key order-insensitive at parse level). */
const expectTree = (state: EditingState, expected: NodeJson | null): void => {
  expect(j(tree(state))).toBe(j(expected));
};
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const tokc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const slotc = (path: readonly (number | string)[], slot: 'num' | 'den' | 'base' | 'exp' | 'child' | 'radicand' | 'index' | 'value'): Caret => ({ kind: 'slot', path, slot });

/** A seeded session with the caret placed (unlogged, host-style). */
const at = (root: NodeJson | null, caret: Caret): EditingState => ({ ...initSession({ v: 1, root }), caret });
/** Type a sequence from the empty formula. */
const typeSeq = (tokens: readonly TypedToken[]): EditingState => {
  let state = initSession();
  for (const t of tokens) state = typeToken(state, t);
  return state;
};

/** The legality gate: the envelope rebuilds through fromJSON (the contract
 *  boundary) and the caret resolves in the rebuilt tree. */
const legal = (state: EditingState): void => {
  const env = envelopeOf(state);
  expect(() => initSession(env)).not.toThrow();
  expect(caretResolvesIn(env, state.caret)).toBe(true);
};

/** A defined no-op: the same state object, nothing logged. */
const expectNoop = (state: EditingState, token: TypedToken): void => {
  const before = j([envelopeOf(state), state.caret, state.log.length]);
  const after = typeToken(state, token);
  expect(j([envelopeOf(after), after.caret, after.log.length])).toBe(before);
};

const expectedEmpty: Envelope = { v: 1, root: null };

// ——— T1: literal operator insertion ———

describe('T1 — literal operator insertion (glyphs appear at the caret, nothing restructures)', () => {
  it('from empty: every glyph creates a bare [null, null] row, caret right after the glyph', () => {
    for (const [token, name] of [[plus, 'add'], [minus, 'subtract'], [times, 'multiply']] as const) {
      const state = typeSeq([token as TypedToken]);
      expectTree(state, op(name as string, null, null));
      expect(state.caret).toEqual(rowc([], 1));
      legal(state);
    }
  });

  it('row start: a leading operator is allowed (S-003)', () => {
    // from a lone symbol: `|a` + `+` → `+|a` (the caret sits before the token)
    const state = typeToken(at(sym('a'), tokc([], 0)), plus);
    expectTree(state, op('add', null, sym('a')));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // the row-start seam of an existing row splices the null in front (leading glyph)
    const seam = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 0)), plus);
    expectTree(seam, op('add', null, sym('a'), sym('b')));
    expect(seam.caret).toEqual(rowc([], 1));
    legal(seam);
  });

  it('a token inside its same-op parent row extends the flat chain (leading and trailing glyphs)', () => {
    // offset len on the row's last operand: `1+2` + `+` → [1, 2, ∅]
    const tail = typeToken(at(op('add', num(1), num(2)), node([1])), plus);
    expectTree(tail, op('add', num(1), num(2), null));
    expect(tail.caret).toEqual(rowc([], 2)); // in the pending cell
    legal(tail);
    // offset 0 (before the token): `1+|2` + `+` → [1, ∅, 2], after the new glyph
    const head = typeToken(at(op('add', num(1), num(2)), tokc([1], 0)), plus);
    expectTree(head, op('add', num(1), null, num(2)));
    expect(head.caret).toEqual(rowc([], 2));
    legal(head);
  });

  it('mid-row alongside: [a,b,c] `a+b+|c` + `+` → [a,b,∅,c] — the S-001 display a+b++c', () => {
    const state = typeToken(at(op('add', sym('a'), sym('b'), sym('c')), rowc([], 2)), plus);
    expectTree(state, op('add', sym('a'), sym('b'), null, sym('c')));
    expect(state.caret).toEqual(rowc([], 3));
    legal(state);
    // the doubled-operator projection still reads it: a+b++c = a+b+c
    expect(isEvaluable(fromJSON(envelopeOf(state))!)).toBe(true);
  });

  it('before an existing operator: S-006 `a|*b` + `−` → a−|*b (the glyph inserts before the ×)', () => {
    const state = typeToken(at(op('multiply', sym('a'), sym('b')), rowc([], 1)), minus);
    expectTree(state, op('subtract', sym('a'), op('multiply', null, sym('b'))));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // continued typing lands in the relocated glyph's pending cell:
    // `2` completes a − 2×b (the math reading of the flat a−2×b text).
    const after2 = typeToken(state, d('2'));
    expectTree(after2, op('subtract', sym('a'), op('multiply', num(2), sym('b'))));
    expect((after2.caret as { kind: string }).kind).toBe('token'); // 4a: OA-token-end
    legal(after2);
  });

  it('row end: same-op extends flat with a pending cell; different-op wraps the whole segment', () => {
    const flat = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 2)), plus);
    expectTree(flat, op('add', sym('a'), sym('b'), null));
    expect(flat.caret).toEqual(rowc([], 2)); // in the pending cell — typing 3 continues
    const wrapped = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 2)), times);
    expectTree(wrapped, op('multiply', op('add', sym('a'), sym('b')), null));
    expect(wrapped.caret).toEqual(rowc([], 1));
    legal(wrapped);
  });

  it('into empty 2D slots: a typed glyph template lands inside the slot', () => {
    const state = typeToken(at(frac(null, num(3)), { kind: 'slot', path: [], slot: 'num' }), times);
    expectTree(state, frac(op('multiply', null, null), num(3)));
    expect(state.caret).toEqual(rowc(['num'], 1));
    legal(state);
  });

  it('at the shared gap (N2): letters glue right, digit-glue joins the left symbol, glyphs splice', () => {
    // letter glues into the right token
    const glued = typeToken(at(op('add', sym('x'), sym('y')), rowc([], 1)), s('z'));
    expectTree(glued, op('add', sym('x'), sym('zy')));
    expect(glued.caret).toEqual(tokc([1], 1));
    legal(glued);
    // a digit joins the left symbol's name (digit-glue amendment)
    const dig = typeToken(at(op('add', sym('x'), sym('y')), rowc([], 1)), d('3'));
    expectTree(dig, op('add', sym('x3'), sym('y')));
    expect(dig.caret).toEqual(rowc([], 1));
    legal(dig);
    // an operator splices the pair apart
    const spliced = typeToken(at(op('add', sym('x'), sym('y')), rowc([], 1)), plus);
    expectTree(spliced, op('add', sym('x'), null, sym('y')));
    expect(spliced.caret).toEqual(rowc([], 2));
    legal(spliced);
  });

  it('the glyph after a typed number flows into the flat chain (2−−3 builds toward the pinned shape)', () => {
    const state = typeSeq([d('2'), minus, minus, d('3')]);
    expectTree(state, op('subtract', num(2), null, num(3)));
    legal(state);
    const ast = fromJSON(envelopeOf(state))!;
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate()).toBe(5);
    expect(parse('2--3').evaluate()).toBe(5);
  });
});

// ——— Null-cell splice: leading / interior / trailing nulls all typing-reachable ———

describe('null-cell splice — null args cells at any index', () => {
  it('leading, interior, trailing nulls are all reachable by typing (S-003/S-001 flows)', () => {
    expectTree(typeSeq([plus, s('a')]), op('add', null, sym('a'))); // leading
    expectTree(
      typeToken(at(op('add', sym('a'), sym('b'), sym('c')), rowc([], 2)), plus),
      op('add', sym('a'), sym('b'), null, sym('c')), // interior
    );
    expectTree(typeSeq([s('a'), plus, s('b'), plus]), op('add', sym('a'), sym('b'), null)); // trailing
  });

  it('the pending null pends the next leaf (fill) — one glyph-chasing flow end to end', () => {
    const state = typeSeq([d('1'), plus, d('2'), plus, d('3'), plus, d('4')]);
    expectTree(state, op('add', num(1), num(2), num(3), num(4)));
    expect(state.log.length).toBe(7); // one op per token
    legal(state);
  });
});

// ——— T3: symbols and numbers are text-like tokens ———

describe('T3 — letters glue, different-type splits, digit-glue, juxtaposition, Space', () => {
  it('letters glue onto the symbol from either side at any caret offset', () => {
    // behind (the post-typing station: node caret on the symbol)
    expectTree(typeSeq([s('a'), s('b')]), sym('ab'));
    // front: token caret at offset 0
    const front = typeToken(at(sym('ab'), tokc([], 0)), s('z'));
    expectTree(front, sym('zab'));
    expect(front.caret).toEqual(tokc([], 1));
    // interior: `a|b` of one symbol
    const mid = typeToken(at(sym('ab'), tokc([], 1)), s('z'));
    expectTree(mid, sym('azb'));
    expect(mid.caret).toEqual(tokc([], 2));
    legal(mid);
  });

  it('different-type input splits a symbol at the caret: `a|b` + `+` → a+|b (S-029)', () => {
    const state = typeToken(at(sym('ab'), tokc([], 1)), plus);
    expectTree(state, op('add', sym('a'), sym('b')));
    // 4a (OA-visual-trumps/N2): the seam right of the glyph IS b's offset 0
    expect(state.caret).toEqual(tokc([1], 0));
    legal(state);
  });

  it('digit-glue (owner amendment, supersedes S-030 A): digits join the symbol NAME wherever letters sit to their left', () => {
    // `x` + `1` → the one symbol `x1`
    expectTree(typeSeq([s('x'), d('1')]), sym('x1'));
    // inside a symbol: `a|b` + `5` → the ONE symbol `a5b`
    const mid = typeToken(at(sym('ab'), tokc([], 1)), d('5'));
    expectTree(mid, sym('a5b'));
    expect(mid.caret).toEqual(tokc([], 2));
    // at the front of a symbol (no letters to the left) a digit starts a number
    const before = typeToken(at(sym('ab'), tokc([], 0)), d('5'));
    expectTree(before, imp(num(5), sym('ab')));
    // 4a (OA-token-end): the typed token's in-token end
    expect(before.caret).toEqual(tokc([0], 1));
    legal(before);
  });

  it('letters before/inside numbers juxtapose/split (S-032/S-031) — number nodes only where no symbol precedes', () => {
    // S-031 A: a letter inside a number → number·symbol·number (flat 3-cell implicit row)
    const inner = typeToken(at(num(123), tokc([], 1)), s('x'));
    expectTree(inner, imp(num(1), sym('x'), num(23)));
    // 4a (OA-token-end): the glyph-less seam after x painted at x's end already
    expect(inner.caret).toEqual(tokc([1], 1));
    legal(inner);
    // S-032: a letter before a number → the juxtaposed symbol-first pair
    const before = typeToken(at(num(123), tokc([], 0)), s('x'));
    expectTree(before, imp(sym('x'), num(123)));
    // 4a (OA-token-end): the typed x's in-token end
    expect(before.caret).toEqual(tokc([0], 1));
    // a letter after a number → the evaluating number-first pair (5x)
    const after = typeToken(at(num(5), node([])), s('x'));
    expectTree(after, imp(num(5), sym('x')));
    // 4a (OA-token-end): the typed x's in-token end (the seam painted there)
    expect(after.caret).toEqual(tokc([1], 1));
    legal(after);
  });

  it('the x3-class adjacency states: typing produces glued names, never symbol-before-number-glue', () => {
    // symbol-then-digit is ONE symbol (digit-glue), never an adjacency row
    expectTree(typeSeq([s('x'), d('3')]), sym('x3'));
    // number-before-symbol evaluates
    const nx = typeSeq([d('5'), s('x')]);
    expect(isEvaluable(fromJSON(envelopeOf(nx))!)).toBe(true);
    expect(fromJSON(envelopeOf(nx))!.toMathNode().evaluate({ x: 4 })).toBe(20);
    // a letter typed before an existing number juxtaposes → symbol-before-number, refused
    const xn = typeToken(at(num(123), tokc([], 0)), s('x'));
    expectTree(xn, imp(sym('x'), num(123)));
    expect(isEvaluable(fromJSON(envelopeOf(xn))!)).toBe(false);
    // glyph-less number-before-number (Space-forced, S-098) refuses — pinned below too
  });

  it('Space inserts a node boundary: splits inside tokens, separates same-type input at edges (S-021/S-022)', () => {
    // inside a number: the S-098 forced number-number adjacency state
    const split = typeToken(at(num(12), tokc([], 1)), space);
    expectTree(split, imp(num(1), num(2)));
    expect(split.caret).toEqual(rowc([], 1));
    expect(split.log.length).toBe(1); // the split IS one op
    legal(split);
    expect(isEvaluable(fromJSON(envelopeOf(split))!)).toBe(false); // S-098: refuses while it persists
    // the seam marker renders between the two numbers
    expect(toMathML(fromJSON(envelopeOf(split))!)).toContain('integral-seam');
    // inside a symbol: two symbol nodes
    const ss = typeToken(at(sym('ab'), tokc([], 1)), space);
    expectTree(ss, imp(sym('a'), sym('b')));
    legal(ss);
    // at a token edge: no tree change, no log entry — the boundary flag arms
    const armed1 = typeToken(at(sym('ab'), node([])), space);
    expectTree(armed1, sym('ab'));
    expect(armed1.log.length).toBe(0);
    expect((armed1.caret as { boundary?: true }).boundary).toBe(true);
    // the NEXT same-type input starts a new node instead of gluing
    const sec = typeToken(armed1, s('c'));
    expectTree(sec, imp(sym('ab'), sym('c')));
    // continued typing glues into the new node
    const third = typeToken(sec, s('d'));
    expectTree(third, imp(sym('ab'), sym('cd')));
    legal(third);
    // Space forced number-number adjacency after a number (S-098)
    const spaced = typeToken(typeToken(typeSeq([d('5')]), space), d('7'));
    expectTree(spaced, imp(num(5), num(7)));
    expect(isEvaluable(fromJSON(envelopeOf(spaced))!)).toBe(false);
    legal(spaced);
  });
});

// ——— T4: numbers ———

describe('T4 — digits extend, the dot states', () => {
  it('digits extend at the caret, in-token offsets included', () => {
    let state = typeSeq([d('1'), d('2')]);
    expectTree(state, num(12));
    const off = typeToken(at(num(123), tokc([], 1)), d('9'));
    expectTree(off, num(1923));
    expect(off.caret).toEqual(tokc([], 2));
    legal(off);
  });

  it('`.` joins a number as its decimal point; a second dot is a silent no-op', () => {
    const state = typeToken(at(num(5), tokc([], 1)), dot);
    expectTree(state, num(5, true));
    expect(state.caret).toEqual(tokc([], 2)); // inside the number, after the dot
    legal(state);
    expect(toMathML(fromJSON(envelopeOf(state))!)).toBe('<math><mn>5.</mn></math>');
    expectJSONRoundTrip(state);
    expectNoop(state, dot);
    // a digit completes the decimal and the flag clears
    const done = typeToken(state, d('3'));
    expectTree(done, num(5.3));
    expect(done.caret).toEqual(tokc([], 3));
    legal(done);
    // a dot inside a number (interior offset) is the decimal point there
    const inner = typeToken(at(num(123), tokc([], 1)), dot);
    expectTree(inner, num(1.23));
    expect(inner.caret).toEqual(tokc([], 2));
    legal(inner);
  });

  it('a `.` that creates a new number auto-prefixes zero — renders `0.`, caret inside after the dot (S-012/S-033)', () => {
    // from the empty formula
    const fromEmpty = typeSeq([dot]);
    expectTree(fromEmpty, num(0, true));
    expect(fromEmpty.caret).toEqual(tokc([], 2));
    legal(fromEmpty);
    // after a symbol: `a` juxtaposed with `0.|` — the ruled S-012 example
    const afterSym = typeToken(at(sym('a'), node([])), dot);
    expectTree(afterSym, imp(sym('a'), num(0, true)));
    expect(afterSym.caret).toEqual(tokc([1], 2));
    legal(afterSym);
    // into a pending 2D slot
    const inSlot = typeToken(at(frac(null, num(3)), { kind: 'slot', path: [], slot: 'num' }), dot);
    expectTree(inSlot, frac(num(0, true), num(3)));
    expect(inSlot.caret).toEqual(tokc(['num'], 2));
    legal(inSlot);
  });

  it('a digit typed next to a `0.` extends it (0.5)', () => {
    const state = typeToken(typeSeq([dot]), d('5'));
    expectTree(state, num(0.5));
    legal(state);
  });
});

// ——— T5/T10: function paren-conversion ———

describe('T5/T10 — paren conversion, bare heads, comma arg append', () => {
  it('typed letters build an ordinary symbol; `(` after a matching name converts to the atomic head', () => {
    const state = typeSeq([s('s'), s('i'), s('n'), open]);
    expectTree(state, fn('sin', [null]));
    expect(state.caret).toEqual(rowc([], 0)); // inside the first argument
    expect(state.log.length).toBe(4); // one op per token
    legal(state);
    // completing a first argument continues inside the call
    const filled = typeToken(state, d('3'));
    expectTree(filled, fn('sin', [num(3)]));
    legal(filled);
  });

  it('T10: with elements to the right the head inserts BARE — no fence added', () => {
    // sin juxtaposed before a number: content stands right → bare head
    const bare = typeToken(at(imp(sym('sin'), num(5)), node([0])), open);
    expectTree(bare, imp(fn('sin', [null], false), num(5)));
    expect(bare.caret).toEqual(rowc([0], 0));
    legal(bare);
    // nothing right → the closing fence is added immediately (S-014 B)
    const closed = typeToken(at(op('add', sym('x'), sym('sin')), node([1])), open);
    expectTree(closed, op('add', sym('x'), fn('sin', [null], true)));
    expect(closed.caret).toEqual(rowc([1], 0));
    legal(closed);
  });

  it('non-matching names keep the ordinary T6 group path', () => {
    const state = typeToken(at(sym('ab'), node([])), open);
    expectTree(state, imp(sym('ab'), group(null, true)));
    expect(state.caret).toEqual({ kind: 'slot', path: [1], slot: 'child' });
    legal(state);
  });

  it('comma appends an argument cell (T5)', () => {
    const state = typeToken(at(fn('sin', [sym('a')]), node([0])), comma);
    expectTree(state, fn('sin', [sym('a'), null]));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    expectNoop(at(op('add', sym('a'), sym('b')), rowc([], 1)), comma); // outside a call: no-op
  });
});

// ——— T6 / S-097: groups never auto-wrap; the movable close paren ———

describe('T6 — group creation, S-097 close-paren pairing, dangling fences', () => {
  it('a plain `(` creates a group with BOTH fences at the caret; content to the left stays outside', () => {
    const fromEmpty = typeSeq([open]);
    expectTree(fromEmpty, group(null, true));
    expect(fromEmpty.caret).toEqual({ kind: 'slot', path: [], slot: 'child' });
    legal(fromEmpty);
    // content to the left stays outside — the 5(□) juxtaposition
    const afterNum = typeToken(at(num(5), node([])), open);
    expectTree(afterNum, imp(num(5), group(null, true)));
    expect(afterNum.caret).toEqual({ kind: 'slot', path: [1], slot: 'child' });
    legal(afterNum);
  });

  it('a typed `)` completes the innermost unclosed open fence (S-097) and lands after it', () => {
    const state = typeToken(at(group(sym('x'), false), node([])), close);
    expectTree(state, group(sym('x'), true));
    // 4a: the whole-structure after-station (the ratified lone-root border)
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'right' });
    legal(state);
    // the function form restores the same call
    const fnState = typeToken(at(fn('sqrt', [sym('a')], false), node([0])), close);
    expectTree(fnState, fn('sqrt', [sym('a')], true));
    legal(fnState);
    // nested: innermost first
    const nested = typeToken(at(group(group(sym('x'), false), true), node(['child'])), close);
    expectTree(nested, group(group(sym('x'), true), true));
    legal(nested);
  });

  it('with nothing unclosed, `)` inserts as a literal dangling close — storable, renders, refused by the gate', () => {
    const fromEmpty = typeSeq([close]);
    expectTree(fromEmpty, fence());
    legal(fromEmpty);
    expect(isEvaluable(fromJSON(envelopeOf(fromEmpty))!)).toBe(false);
    const afterNum = typeToken(at(num(5), node([])), close);
    expectTree(afterNum, imp(num(5), fence()));
    legal(afterNum);
    expect(isEvaluable(fromJSON(envelopeOf(afterNum))!)).toBe(false);
  });
});

// ——— The widened pair rule + the mixed-multiply-row definition ———

describe('juxtaposition evaluation — the widened pair rule (group-before-X ruled 2026-11-08)', () => {
  it('a GROUP before X evaluates as implicit multiply, like number-before-X', () => {
    const env = imp(group(op('add', sym('a'), sym('b'))), sym('x'));
    const ast = fromJSON({ v: 1, root: env })!;
    const scope = { a: 1, b: 2, x: 4 };
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate(scope)).toBe(12);
    expect(parse('(a+b)*x').evaluate(scope)).toBe(12);
  });

  it('number-before-X evaluates; fn/unit-before-X still refuse (ruled unchanged)', () => {
    const numFirst = fromJSON({ v: 1, root: imp(num(5), sym('x')) })!;
    expect(isEvaluable(numFirst)).toBe(true);
    const fnFirst = fromJSON({ v: 1, root: imp(fn('sqrt', [num(4)]), sym('x')) })!;
    expect(isEvaluable(fnFirst)).toBe(false);
    expect(() => fnFirst.toMathNode()).toThrow(/implicit adjacency/);
    const unitFirst = fromJSON({ v: 1, root: imp({ type: 'unit', value: num(5), unit: 'mm' }, sym('x')) })!;
    expect(isEvaluable(unitFirst)).toBe(false);
  });
});

describe('mixed multiply rows — juxtaposition never shares a row with explicit glyphs', () => {
  it('explicit × after glyph-less 5x nests the implicit subrow: `5x|` + `×` → [implicit{5,x}, null]', () => {
    const state = typeToken(typeSeq([d('5'), s('x')]), times);
    expectTree(state, op('multiply', imp(num(5), sym('x')), null));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // filling the pending cell completes the explicit segment: 5x×3 evaluates 5·x·3
    const filled = typeToken(state, d('3'));
    expectTree(filled, op('multiply', imp(num(5), sym('x')), num(3)));
    expect(fromJSON(envelopeOf(filled))!.toMathNode().evaluate({ x: 2 })).toBe(30);
    legal(filled);
  });

  it('a letter after an explicit edge cell nests into it: `2×3|` + `x` → [2, implicit{3,x}]', () => {
    const state = typeToken(typeSeq([d('2'), times, d('3')]), s('x'));
    expectTree(state, op('multiply', num(2), imp(num(3), sym('x'))));
    legal(state);
    expect(fromJSON(envelopeOf(state))!.toMathNode().evaluate({ x: 4 })).toBe(24);
  });

  it('required pin (owner-confirmed definition): marker-carrying subrows never flatten into explicit parents — both directions', () => {
    // typing produces the nested shape only …
    const typed = typeSeq([d('5'), s('x'), times, d('3')]);
    expectTree(typed, op('multiply', imp(num(5), sym('x')), num(3)));
    // … and fromJSON/toJSON round-trips the nesting byte-identically —
    // the marked subrow survives as its own cell, never flattened away.
    const env = envelopeOf(typed);
    const round = toJSON(fromJSON(env)!);
    expect(j(round)).toBe(j(env));
    // a seeded explicit row with a marked cell stays nested too (identity)
    const seeded = op('multiply', imp(num(5), sym('x')), num(3));
    const seededEnv = { v: 1, root: seeded };
    expect(j(toJSON(fromJSON(seededEnv)!))).toBe(j(seededEnv));
    // the marker is what distinguishes the subrow from a flattenable chain:
    // the same cells WITHOUT the marker are a legal plain explicit row.
    const plain = op('multiply', num(5), sym('x'), num(3));
    expect(j(toJSON(fromJSON({ v: 1, root: plain })!))).toBe(j({ v: 1, root: plain }));
  });
});

// ——— T7: structure keys (rework session 2b-1) ———

describe('T7 — the fraction key `/` creates a fraction over the preceding node', () => {
  it('`a+b|` grabs only b: add[a, frac(b, □)], caret at the denominator slot start (S-019)', () => {
    const state = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 2)), { t: 'divide' });
    expectTree(state, op('add', sym('a'), frac(sym('b'), null)));
    expect(state.caret).toEqual(slotc([1], 'den'));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('`(a+b)|` grabs the whole group — the owner’s T7 example', () => {
    const state = typeToken(at(group(op('add', sym('a'), sym('b'))), node([])), { t: 'divide' });
    expectTree(state, frac(group(op('add', sym('a'), sym('b'))), null));
    expect(state.caret).toEqual(slotc([], 'den'));
    legal(state);
  });

  it('`a|` whole-token grab: frac(a, □), caret in the denominator (S-019); typing continues into the slot', () => {
    let state = typeToken(at(sym('a'), node([])), { t: 'divide' });
    expectTree(state, frac(sym('a'), null));
    expect(state.caret).toEqual(slotc([], 'den'));
    legal(state);
    state = typeToken(state, s('b'));
    expectTree(state, frac(sym('a'), sym('b')));
    // 4a (OA-token-end): the typed b's in-token end
    expect(state.caret).toEqual(tokc(['den'], 1));
    legal(state);
  });

  it('no preceding node — empty formula: the empty fraction, both slots □, caret in the numerator (S-025 A derived reading)', () => {
    const state = typeToken(initSession(), { t: 'divide' });
    expectTree(state, frac(null, null));
    expect(state.caret).toEqual(slotc([], 'num'));
    legal(state);
  });

  it('no preceding node — dangling operator `a+|`: the empty fraction fills the pending operand (S-025 A)', () => {
    // both caret readings of the dangling plus: the void ON the null cell, the seam past it
    const voidCell = typeToken(at(op('add', sym('a'), null), rowc([], 1)), { t: 'divide' });
    expectTree(voidCell, op('add', sym('a'), frac(null, null)));
    expect(voidCell.caret).toEqual(slotc([1], 'num'));
    legal(voidCell);
    const seam = typeToken(at(op('add', sym('a'), null), rowc([], 2)), { t: 'divide' });
    expectTree(seam, op('add', sym('a'), frac(null, null)));
    expect(seam.caret).toEqual(slotc([1], 'num'));
    legal(seam);
  });

  it('row start `|a+b`: the empty fraction juxtaposes before the first cell, caret in its numerator', () => {
    const state = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 0)), { t: 'divide' });
    expectTree(state, op('add', imp(frac(null, null), sym('a')), sym('b')));
    expect(state.caret).toEqual(slotc([0, 0], 'num'));
    legal(state);
  });

  it('mid-token split — the uniform reading (owner ruling 2026-11-09): `12|3` + `/` → frac(12, 3), caret before the 3 in the denominator (the after-the-slash position)', () => {
    const state = typeToken(at(num(123), tokc([], 1)), { t: 'divide' });
    expectTree(state, frac(num(1), num(23)));
    expect(state.caret).toEqual(tokc(['den'], 0));
    legal(state);
  });

  it('offset 0 — the uniform reading’s left edge: `|123` + `/` → frac(□, 123), caret before the content in the denominator', () => {
    const state = typeToken(at(num(123), tokc([], 0)), { t: 'divide' });
    expectTree(state, frac(null, num(123)));
    expect(state.caret).toEqual(tokc(['den'], 0));
    legal(state);
  });

  it('op rows are transparent at their flanks: `a+b·c|` + `/` grabs c (the immediately preceding node)', () => {
    const state = typeToken(
      at(op('add', sym('a'), op('multiply', sym('b'), sym('c'))), rowc([], 2)),
      { t: 'divide' },
    );
    expectTree(state, op('add', sym('a'), op('multiply', sym('b'), frac(sym('c'), null))));
    expect(state.caret).toEqual(slotc([1, 1], 'den'));
    legal(state);
  });
});

describe('T7 — the power key `^` creates a power over the preceding node', () => {
  it('`a|` → pow(a, □), caret at the exponent slot start (S-018)', () => {
    let state = typeToken(at(sym('a'), node([])), { t: 'pow' });
    expectTree(state, pow(sym('a'), null));
    expect(state.caret).toEqual(slotc([], 'exp'));
    legal(state);
    state = typeToken(state, d('2'));
    expectTree(state, pow(sym('a'), num(2)));
    // 4a re-pin (OA-token-end): the typed 2's in-token end — never a
    // whole-node caret (the state that painted at the element's LEFT edge)
    expect(state.caret).toEqual(tokc(['exp'], 1));
    legal(state);
  });

  it('`a+b|` grabs only b; `(a+b)|` grabs the whole group', () => {
    const seam = typeToken(at(op('add', sym('a'), sym('b')), rowc([], 2)), { t: 'pow' });
    expectTree(seam, op('add', sym('a'), pow(sym('b'), null)));
    expect(seam.caret).toEqual(slotc([1], 'exp'));
    legal(seam);
    const whole = typeToken(at(group(op('add', sym('a'), sym('b'))), node([])), { t: 'pow' });
    expectTree(whole, pow(group(op('add', sym('a'), sym('b'))), null));
    expect(whole.caret).toEqual(slotc([], 'exp'));
    legal(whole);
  });

  it('no preceding node — empty formula: pow(□, □), caret in the exponent (the 2b-1 derived reading)', () => {
    const state = typeToken(initSession(), { t: 'pow' });
    expectTree(state, pow(null, null));
    expect(state.caret).toEqual(slotc([], 'exp'));
    legal(state);
  });

  it('no preceding node — dangling operator `a+|`: pow(□, □) fills the pending operand, caret in the exponent', () => {
    const voidCell = typeToken(at(op('add', sym('a'), null), rowc([], 1)), { t: 'pow' });
    expectTree(voidCell, op('add', sym('a'), pow(null, null)));
    expect(voidCell.caret).toEqual(slotc([1], 'exp'));
    legal(voidCell);
  });

  it('mid-token split — the uniform reading: `a|bc` + `^` → pow(a, bc), caret at bc’s start in the exponent; `|bc` → pow(□, bc)', () => {
    const mid = typeToken(at(sym('abc'), tokc([], 1)), { t: 'pow' });
    expectTree(mid, pow(sym('a'), sym('bc')));
    expect(mid.caret).toEqual(tokc(['exp'], 0));
    legal(mid);
    const leftEdge = typeToken(at(sym('bc'), tokc([], 0)), { t: 'pow' });
    expectTree(leftEdge, pow(null, sym('bc')));
    expect(leftEdge.caret).toEqual(tokc(['exp'], 0));
    legal(leftEdge);
  });
});

describe('T7 — undo: one structure key = one log entry (U2/S-083); redo mirrors', () => {
  it('undo unwinds the whole creation including the grab — `b` back in the row, caret restored; redo re-applies', () => {
    const seed = op('add', sym('a'), sym('b'));
    const caret = rowc([], 2);
    const state = typeToken(at(seed, caret), { t: 'divide' });
    expect(state.log.length).toBe(1);
    const back = undo(state);
    expectTree(back, seed);
    expect(back.caret).toEqual(caret);
    legal(back);
    const again = redo(back);
    expectTree(again, op('add', sym('a'), frac(sym('b'), null)));
    expect(again.caret).toEqual(slotc([1], 'den'));
    legal(again);
  });

  it('undo unwinds a mid-token split: the unsplit token AND its in-token caret return byte-exactly (S-083 pattern)', () => {
    const state = typeToken(at(num(123), tokc([], 1)), { t: 'divide' });
    const back = undo(state);
    expectTree(back, num(123));
    expect(back.caret).toEqual(tokc([], 1));
    legal(back);
  });
});

describe('T7 render pins: every structure-key state renders its □ slots (S-018/S-019/S-025/S-027)', () => {
  it('the string renderer paints □ for each created empty slot — the DOM parity pin covers the builder', () => {
    const den = typeToken(at(sym('a'), node([])), { t: 'divide' });
    expect(toMathML(fromJSON(envelopeOf(den))!)).toBe('<math><mfrac><mi>a</mi><mi>□</mi></mfrac></math>');
    const exp = typeToken(at(sym('a'), node([])), { t: 'pow' });
    expect(toMathML(fromJSON(envelopeOf(exp))!)).toBe('<math><msup><mi>a</mi><mi>□</mi></msup></math>');
    const emptyFrac = typeToken(initSession(), { t: 'divide' });
    expect(toMathML(fromJSON(envelopeOf(emptyFrac))!)).toBe('<math><mfrac><mi>□</mi><mi>□</mi></mfrac></math>');
    const emptyPow = typeToken(at(op('add', sym('a'), null), rowc([], 1)), { t: 'pow' });
    expect(toMathML(fromJSON(envelopeOf(emptyPow))!)).toContain('<msup><mi>□</mi><mi>□</mi></msup>');
  });
});

// ——— Rejections are silent no-ops ———

describe('the standing rejection pattern: rejected keys are silent no-ops', () => {
  it('second dot in a number (S-013), comma outside any call, Space in a void', () => {
    expectNoop(at(num(5.5), tokc([], 3)), dot);
    expectNoop(at(op('add', sym('a'), sym('b')), rowc([], 1)), comma);
    expectNoop(initSession(), space);
    expectNoop(initSession(), comma);
  });
});

// ——— One op per typed token; undo steps one token back ———

describe('discipline: one typed token = one op = one undo step; movement never logs', () => {
  it('a long mixed sequence logs exactly one op per non-Space token (Space never logs)', () => {
    const flow: TypedToken[] = [d('5'), plus, s('x'), space, s('y'), times, open, d('2'), close];
    let state = initSession();
    let ops = 0;
    for (const t of flow) {
      const before = state.log.length;
      state = typeToken(state, t);
      const grown = state.log.length - before;
      expect(grown).toBeLessThanOrEqual(1);
      ops += grown;
      // every intermediate state is fromJSON-legal with a resolving caret
      legal(state);
    }
    expect(ops).toBe(flow.length - countSpaces(flow));
    expect(state.log.length).toBe(ops);
  });

  it('undo steps one typed token back, byte-exactly (tree + caret)', () => {
    const flow: TypedToken[] = [d('5'), plus, s('x'), times, d('2')];
    const states: EditingState[] = [];
    let state = initSession();
    states.push(state);
    for (const t of flow) {
      state = typeToken(state, t);
      states.push(state);
    }
    for (let i = flow.length; i > 0; i -= 1) {
      state = undo(state);
      expectTree(state, tree(states[i - 1]));
      legal(state);
    }
    expect(j(envelopeOf(state))).toBe(j(expectedEmpty));
    expect(state.caret).toEqual({ kind: 'empty' });
  });

  it('pure caret movement never enters the log (the standing rule)', () => {
    const state = at(op('add', sym('a'), sym('b')), rowc([], 1));
    const moved = applyOp(state, { op: 'move', dir: 'right' });
    expect(moved.log.length).toBe(0);
    expect(moved.log).toBe(state.log);
  });
});

/** Count of space tokens in a flow (the boundary arming never logs). */
function countSpaces(flow: readonly TypedToken[]): number {
  return flow.filter((t) => t.t === 'space').length;
}

/** fromJSON/toJSON round-trip identity for a state's envelope. */
function expectJSONRoundTrip(state: EditingState): void {
  const env = envelopeOf(state);
  expect(j(toJSON(fromJSON(env)!))).toBe(j(env));
}

/** Operator-name sanity for the glyph set (× is the multiply row). */
describe('operator glyph sanity', () => {
  it('the three T1 glyph ops are add/subtract/multiply rows', () => {
    const fns: Readonly<[TypedToken, OperatorFn]>[] = [
      [plus, 'add'],
      [minus, 'subtract'],
      [times, 'multiply'],
    ];
    for (const [token, name] of fns) {
      const state = typeSeq([s('a'), token]);
      expect((tree(state) as unknown as { op: string }).op).toBe(name);
    }
  });
});
