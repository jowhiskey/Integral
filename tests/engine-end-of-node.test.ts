// End-of-node positions (session-4 fix arc): three within-design bugs of the
// caret union, one design limit untouched. (1) Digit typing merges into a
// number from a node caret standing on it (the number's OWN end station — the
// same read backspace peels from), making multi-digit typing work from the
// empty formula, slots, and row cells. (2) A horizontal overflow that runs a
// row's border with no station up the climb rests at that row's border seam —
// the expressible row end stations are reachable at last (movement + click).
// (3) Typing at the row-end seam routes to the last operand's hold: operators
// extend/wrap as they do standing on that operand, digits merge into a
// trailing number, juxtaposition after a symbol stays the typed rejection.
// Every state built here is fromJSON-legal through the reducer by
// construction; the end-of-non-row-root station remains unexpressible (a
// design limit, pinned by negative tests below).

import { describe, expect, it } from 'vitest';

import {
  applyOp,
  backspace,
  caretResolvesIn,
  envelopeOf,
  initSession,
  resolveMove,
  typeToken,
  redo,
  undo,
  type Caret,
  type EditingState,
  type TypedToken,
} from '../src/engine/index.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const d = (str: string): TypedToken => ({ t: 'leaf', node: { type: 'num', value: Number(str) } });
const letter = (name: string): TypedToken => ({ t: 'leaf', node: { type: 'sym', name } });
const plus: TypedToken = { t: 'operator', fn: 'add' };
const times: TypedToken = { t: 'operator', fn: 'multiply' };
const divide: TypedToken = { t: 'divide' };

const j = (x: unknown): string => JSON.stringify(x);

const seed = (root: unknown): EditingState => initSession({ v: 1, root: root as never });
const at = (state: EditingState, caret: Caret): EditingState => applyOp(state, { op: 'moveCaret', to: caret });
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const tok = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'token', path, index });

/** Every fix-flow end state: the envelope rebuilds through the fromJSON gate
 * (initSession) and the caret resolves in it (the expressibility/legality
 * acceptance criterion). */
const legalEndState = (s: EditingState): void => {
  const env = envelopeOf(s);
  expect(() => initSession(env)).not.toThrow();
  expect(caretResolvesIn(env, s.caret)).toBe(true);
};


describe('digit typing merges at the number’s own end station (node caret on a number)', () => {
  it('expressibility: the token end offset is a legal caret at root, in slots, and in row cells', () => {
    expect(caretResolvesIn({ v: 1, root: num(50) }, tok([], 2))).toBe(true);
    expect(caretResolvesIn({ v: 1, root: { type: 'frac', num: num(50), den: num(3) } }, tok(['num'], 2))).toBe(true);
    expect(caretResolvesIn({ v: 1, root: { type: 'op', op: 'add', args: [sym('x'), num(50)] } }, tok([1], 2))).toBe(true);
  });

  it('typing 1 then 2 from the empty formula yields 12 (one op per digit, undo steps one digit back)', () => {
    let s = initSession();
    s = typeToken(s, d('1'));
    s = typeToken(s, d('2'));
    expect(j(envelopeOf(s).root)).toBe(j(num(12)));
    expect(s.caret).toEqual(node([])); // the station survives the merge: repeated digits keep landing
    expect(s.log.length).toBe(2);
    const u = undo(s);
    expect(j(envelopeOf(u).root)).toBe(j(num(1)));
    const r = redo(u);
    expect(j(envelopeOf(r).root)).toBe(j(num(12)));
    expect(j(r.caret)).toBe(j(s.caret)); // redo is byte-exact (tree + caret)
    legalEndState(s);
  });

  it('typing fills a slot and then merges into the number there (a numerator takes multi-digit input)', () => {
    let s = seed({ type: 'frac', num: null, den: num(3) });
    s = typeToken(s, d('1')); // operand: fill
    expect(s.caret).toEqual(node(['num']));
    s = typeToken(s, d('2')); // merge at the number's end
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'frac', num: num(12), den: num(3) }));
    expect(s.caret).toEqual(node(['num']));
    expect(s.log.length).toBe(2);
    legalEndState(s);
  });

  it('a mid-row or last-row number merges the same way (50 → 507)', () => {
    const mid = at(seed({ type: 'op', op: 'add', args: [num(50), sym('x')] }), node([0]));
    const m1 = typeToken(mid, d('7'));
    expect(j(envelopeOf(m1).root)).toBe(j({ type: 'op', op: 'add', args: [num(507), sym('x')] }));
    expect(m1.caret).toEqual(node([0]));
    const last = at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), node([1]));
    const l1 = typeToken(last, d('7'));
    expect(j(envelopeOf(l1).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), num(507)] }));
    expect(l1.log.length).toBe(last.log.length + 1);
  });

  it('the keyboard path works end to end: 12+34 and 12/3 typed digit by digit', () => {
    let s = initSession();
    for (const t of [d('1'), d('2'), plus, d('3'), d('4')]) s = typeToken(s, t);
    expect(j(envelopeOf(s).root)).toBe(
      j({ type: 'op', op: 'add', args: [num(12), num(34)] }),
    );
    expect(s.caret).toEqual(node([1]));
    expect(s.log.length).toBe(5);
    legalEndState(s);

    let f = initSession();
    for (const t of [d('1'), d('2'), divide, d('3')]) f = typeToken(f, t);
    expect(j(envelopeOf(f).root)).toBe(j({ type: 'frac', num: num(12), den: num(3) }));
    expect(j(f.caret)).toBe(j(node(['den'])));
    expect(f.log.length).toBe(4);
    legalEndState(f);
  });

  it('letters at a node caret on a number juxtapose (T3 rework); operators keep their wrap', () => {
    const s = at(seed(num(50)), node([]));
    const jp = typeToken(s, letter('x'));
    expect(j(envelopeOf(jp).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(50), sym('x')], implicit: true }),
    );
    expect(jp.log.length).toBe(2); // the moveCaret seed + the juxtaposition op
    legalEndState(jp);
    // a structure token wraps the number as it always did at that station
    const w = typeToken(s, plus);
    expect(j(envelopeOf(w).root)).toBe(j({ type: 'op', op: 'add', args: [num(50), null] }));
  });
});

describe('the row-end seam is a reachable station (dead-end overflow rests there)', () => {
  const xFrac = { type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: sym('a'), den: sym('b') }] };
  const fracX = { type: 'op', op: 'add', args: [{ type: 'frac', num: sym('a'), den: sym('b') }, sym('x')] };

  it('expressibility: the end seam is legal caret data (fromJSON-clean envelope + validity)', () => {
    const env = envelopeOf(seed(xFrac));
    expect(caretResolvesIn(env, rowc([], 2))).toBe(true);
    expect(() => initSession(env)).not.toThrow();
  });

  it('right out of the LAST fraction parks after it; the seam itself is the terminal (no oscillation)', () => {
    const env = envelopeOf(seed(xFrac));
    expect(resolveMove(env, node([1, 'den']), 'right')).toEqual(rowc([], 2));
    expect(resolveMove(env, rowc([], 2), 'right')).toBe(null);
  });

  it('left out of the FIRST fraction symmetrically parks before the row', () => {
    const env = envelopeOf(seed(fracX));
    expect(resolveMove(env, node([0, 'num']), 'left')).toEqual(rowc([], 0));
    expect(resolveMove(env, rowc([], 0), 'left')).toBe(null);
  });

  it('design limit pinned: non-row roots still have no station beyond (null, unchanged)', () => {
    expect(resolveMove(envelopeOf(seed(num(50))), node([]), 'right')).toBe(null);
    expect(resolveMove(envelopeOf(seed({ type: 'frac', num: sym('a'), den: sym('b') })), node(['den']), 'right')).toBe(null);
  });
});

describe('typing at the row-end seam (route to the last operand’s hold / trailing-number merge)', () => {
  it('the post-backspace seam recovers: x+y, delete y (D1: pending null), z fills the dangling glyph (rework session 3 re-pin)', () => {
    let s = at(seed({ type: 'op', op: 'add', args: [sym('x'), sym('y')] }), node([1]));
    s = backspace(s); // D1: the emptied token leaves the PENDING NULL — the glyph survives
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), null] }));
    expect(s.caret).toEqual(rowc([], 1)); // the freed spot: the caret sits in the pending cell
    s = typeToken(s, letter('z')); // the dangling + operand fills — no retype needed
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), sym('z')] }));
    expect(s.caret).toEqual(node([1]));
    expect(s.log.length).toBe(3); // the moveCaret seed + delete + fill
    legalEndState(s);
  });

  it('a digit at the seam merges into a trailing number and the seam caret survives the replace', () => {
    let s = at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), rowc([], 2));
    s = typeToken(s, d('7'));
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), num(507)] }));
    expect(s.caret).toEqual(rowc([], 2)); // the seam is not owned by the cell it follows
    s = typeToken(s, d('8'));
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), num(5078)] }));
    expect(s.log.length).toBe(3); // the moveCaret seed + two merges
    legalEndState(s);
  });

  it('a structure token at the seam wraps the trailing number; typing types as the last operand (caret dives into the wrapper)', () => {
    let s = at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), rowc([], 2));
    s = typeToken(s, divide); // ÷ nests in the right operand (the last operand's hold)
    expect(j(envelopeOf(s).root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(50), den: null }] }),
    );
    expect(j(s.caret)).toBe(j({ kind: 'slot', path: [1], slot: 'den' })); // identical to typing on the 50
    s = typeToken(s, d('3')); // the fill lands the caret on the 3, so:
    expect(j(envelopeOf(s).root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(50), den: num(3) }] }),
    );
    expect(j(s.caret)).toBe(j(node([1, 'den'])));
    s = typeToken(s, d('0')); // …the next digit merges into the denominator
    expect(j(envelopeOf(s).root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(50), den: num(30) }] }),
    );
    legalEndState(s);
  });

  it('the literal-rework seam rules: digit-glue after a symbol, juxtaposition after a number', () => {
    // digit at the end seam after a symbol joins the left NAME (digit-glue amendment)
    const dig = typeToken(at(seed({ type: 'op', op: 'add', args: [sym('x'), sym('y')] }), rowc([], 2)), d('3'));
    expect(j(envelopeOf(dig).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), sym('y3')] }));
    expect(dig.caret).toEqual(rowc([], 2)); // the seam survives the replace
    legalEndState(dig);
    // letter after a number at the end seam: the juxtaposition pair (5z)
    const jp = typeToken(at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), rowc([], 2)), letter('z'));
    expect(j(envelopeOf(jp).root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), { type: 'op', op: 'multiply', args: [num(50), sym('z')], implicit: true }] }),
    );
    legalEndState(jp);
    // an interior seam after a symbol: the digit joins the left name too
    const interior = typeToken(at(seed({ type: 'op', op: 'add', args: [sym('x'), sym('y')] }), rowc([], 1)), d('3'));
    expect(j(envelopeOf(interior).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x3'), sym('y')] }));
    legalEndState(interior);
  });
});

describe('relocation carries the end-of-node stations', () => {
  it('a splice shifts the seam caret with the row coordinates', () => {
    const s = at(seed({ type: 'op', op: 'add', args: [sym('a'), sym('b')] }), rowc([], 2));
    const s2 = applyOp(s, { op: 'insert', node: num(1), at: { at: 'row', path: [], index: 0 } });
    expect(s2.caret).toEqual(rowc([], 3));
    legalEndState(s2);
  });

  it('backspace at the end seam deletes the last cell and the seam follows (x+50| → x+5|; the emptied number leaves the pending null — rework session 3 re-pin of D1)', () => {
    let s = at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), rowc([], 2));
    s = backspace(s); // seam target: the last cell, digit-wise peel
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), num(5)] }));
    expect(s.caret).toEqual(rowc([], 2)); // the seam survives the shorten replace
    s = backspace(s); // peel again: the number empties → the PENDING NULL (the + stays dangling)
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), null] }));
    expect(s.caret).toEqual(rowc([], 1)); // the freed spot: the caret sits in the pending cell
    legalEndState(s);
  });

  it('undo/redo through the trailing-number merge is byte-exact on tree and caret', () => {
    const seam = at(seed({ type: 'op', op: 'add', args: [sym('x'), num(50)] }), rowc([], 2));
    const s = typeToken(seam, d('7'));
    const u = undo(s);
    expect(j(envelopeOf(u).root)).toBe(j(envelopeOf(seam).root));
    expect(j(u.caret)).toBe(j(seam.caret));
    const r = redo(u);
    expect(j(envelopeOf(r).root)).toBe(j(envelopeOf(s).root));
    expect(j(r.caret)).toBe(j(s.caret));
  });
});

describe('a different-op glyph at the end seam wraps the whole segment (one op, one log entry)', () => {
  it('× at the end seam of a+b+c| wraps the row: multiply[add(row), null], caret after the glyph', () => {
    let s = at(seed({ type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] }), rowc([], 3));
    s = typeToken(s, times);
    expect(j(envelopeOf(s).root)).toBe(
      j({
        type: 'op',
        op: 'multiply',
        args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] }, null],
      }),
    );
    expect(s.caret).toEqual({ kind: 'row', path: [], index: 1 }); // directly after the × glyph
    expect(s.log.length).toBe(2); // the moveCaret seed + one structural op
    legalEndState(s);
  });
});
