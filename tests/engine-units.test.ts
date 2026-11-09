// Unit typing (rework session 2b-2) — the S-051/S-104 acceptance pins:
// the leave-run conversion (settleUnits), the granular unit label as an
// in-token token (letter-wise nav letter glue, digit glue + the derived
// reversion), caret mapping onto the converted unit, and the one-op-per-run
// undo discipline. Every produced state passes the fromJSON gate by
// construction (every settle is a place op through the reducer).

import { describe, expect, it } from 'vitest';
import { fromJSON, type Envelope, type NodeJson } from '../src/ast/index.js';
import {
  caretResolvesIn,
  envelopeOf,
  initSession,
  redo,
  resolveMove,
  settleUnits,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type TypedToken,
} from '../src/engine/index.js';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const imp = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'multiply', args, implicit: true });
const unitn = (value: NodeJson, u: string): NodeJson => ({ type: 'unit', value, unit: u });
const add = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'add', args });
const fracc = (n: NodeJson | null, d: NodeJson | null): NodeJson => ({ type: 'frac', num: n, den: d });

const d = (str: string): TypedToken => ({ t: 'leaf', node: { type: 'num', value: Number(str) } });
const s = (ch: string): TypedToken => ({ t: 'leaf', node: { type: 'sym', name: ch } });
const plus: TypedToken = { t: 'operator', fn: 'add' };
const space: TypedToken = { t: 'space' };
const divide: TypedToken = { t: 'divide' };

const j = (x: unknown): string => JSON.stringify(x);
const treeOf = (state: EditingState): NodeJson | null => envelopeOf(state).root;
const expectTree = (state: EditingState, expected: NodeJson | null): void => {
  expect(j(treeOf(state))).toBe(j(expected));
};
/** Every produced state stays fromJSON-legal with a resolving caret. */
const expectLegal = (state: EditingState): void => {
  expect(() => fromJSON(envelopeOf(state))).not.toThrow();
  expect(caretResolvesIn(envelopeOf(state), state.caret)).toBe(true);
};

/** A seeded session with the caret placed (unlogged, host-style). */
const at = (root: NodeJson | null, caret: Caret): EditingState => ({ ...initSession({ v: 1, root }), caret });
/** Type typed `50mm` (an as-typed unit run, still an ordinary symbol pair). */
const typedRun = (): EditingState => {
  let state = initSession();
  for (const t of [d('5'), d('0'), s('m'), s('m')] as TypedToken[]) state = typeToken(state, t);
  return state;
};

describe('S-051 — the leave-run conversion (settleUnits)', () => {
  it('a typed letter run after a number has NOT converted while typing (letters leave nothing)', () => {
    const state = typedRun();
    expectTree(state, imp(num(50), sym('mm')));
    // 4a re-pin (OA-token-end): the typed run's in-token end
    expect(state.caret).toEqual({ kind: 'token', path: [1], index: 2 });
    expectLegal(state);
  });

  it('settle converts the run into an attached unit — one op, node-caret landing', () => {
    const before = typedRun();
    const next = settleUnits(before);
    expectTree(next, unitn(num(50), 'mm'));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 2 }); // the label's right edge
    expect(next.log.length).toBe(before.log.length + 1); // one place op per converted run
    expectLegal(next);
  });

  it('longest match: the whole run `mm` converts to the unit `mm` (never a shorter suffix)', () => {
    // type `50mm` where BOTH `m` and `mm` are vocabulary units
    const next = settleUnits(typedRun());
    expect((treeOf(next) as { unit: string }).unit).toBe('mm');
  });

  it('unknown runs stay ordinary symbols — the settle is a byte-identical no-op', () => {
    let state = initSession();
    for (const t of [d('5'), d('0'), s('m'), s('m'), s('x')] as TypedToken[]) state = typeToken(state, t);
    expectTree(state, imp(num(50), sym('mmx')));
    expect(settleUnits(state)).toBe(state); // same object: no op, no log growth
  });

  it('a single known letter after a number converts (the run is however long it grew)', () => {
    let state = initSession();
    for (const t of [d('5'), s('m')] as TypedToken[]) state = typeToken(state, t);
    const next = settleUnits(state);
    expectTree(next, unitn(num(5), 'm'));
  });

  it('numbers only (the session ruling): symbol runs, [sym, num] pairs, and unit values never convert', () => {
    const letters = at(sym('mm'), { kind: 'node', path: [] });
    expect(settleUnits(letters)).toBe(letters);
    const symNum = at(imp(sym('x'), num(3)), { kind: 'row', path: [], index: 2 });
    expect(settleUnits(symNum)).toBe(symNum);
    const unitValued = at(imp(unitn(num(2), 's'), num(1)), { kind: 'row', path: [], index: 2 });
    expect(settleUnits(unitValued)).toBe(unitValued); // a unit value is not a plain number run
  });

  it('pairs convert at any nesting (owned slots and fn args alike) — pre-order, one op per run', () => {
    const seed = at(
      add(imp(num(2), sym('s')), imp(num(3), sym('m'))),
      { kind: 'row', path: [], index: 2 },
    );
    const next = settleUnits(seed);
    expectTree(next, add(unitn(num(2), 's'), unitn(num(3), 'm')));
    expect(next.log.length).toBe(seed.log.length + 2);
    expectLegal(next);
    const deep = at(
      fracc(imp(num(5), sym('km')), { type: 'fn', name: 'f', args: [imp(num(1), sym('s'))] }),
      { kind: 'node', path: ['den'] },
    );
    const settled = settleUnits(deep);
    expectTree(settled, fracc(unitn(num(5), 'km'), { type: 'fn', name: 'f', args: [unitn(num(1), 's')] }));
    expect(settled.caret).toEqual(deep.caret); // the unrelated node caret survives
  });

  it('undo restores the symbol run and caret byte-exactly; redo re-applies (S-083 discipline)', () => {
    const typed = typedRun();
    const settled = settleUnits(typed);
    const undone = undo(settled);
    expectTree(undone, imp(num(50), sym('mm')));
    expect(undone.caret).toEqual(typed.caret);
    const redone = redo(undone);
    expectTree(redone, unitn(num(50), 'mm'));
    expect(redone.caret).toEqual(settled.caret);
  });
});

describe('S-051 — caret mapping onto the converted unit', () => {
  const pair: NodeJson = imp(num(50), sym('mm'));

  it('a caret inside the run carries its label offset', () => {
    const next = settleUnits(at(pair, { kind: 'token', path: [1], index: 1 }));
    expectTree(next, unitn(num(50), 'mm'));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 1 });
  });

  it('a caret inside the number carries its offset onto the unit value', () => {
    const next = settleUnits(at(pair, { kind: 'token', path: [0], index: 1 }));
    expect(next.caret).toEqual({ kind: 'token', path: ['value'], index: 1 });
  });

  it('the pair seam between value and run maps to the label start; the seam before maps out left; the seam after rests at the label edge', () => {
    expect(settleUnits(at(pair, { kind: 'row', path: [], index: 1 })).caret).toEqual({ kind: 'token', path: [], index: 0 });
    expect(settleUnits(at(pair, { kind: 'row', path: [], index: 2 })).caret).toEqual({ kind: 'token', path: [], index: 2 });
    const inRow = settleUnits(at(add(pair, num(9)), { kind: 'row', path: [], index: 0 }));
    expectTree(inRow, add(unitn(num(50), 'mm'), num(9)));
    expect(inRow.caret).toEqual({ kind: 'row', path: [], index: 0 }); // the seam before: byte-identical
  });

  it('a caret elsewhere survives untouched', () => {
    const next = settleUnits(at(add(num(1), pair, num(9)), { kind: 'node', path: [2] }));
    expect(next.caret).toEqual({ kind: 'node', path: [2] });
  });
});

describe('S-104 — the granular unit label (typed edits inside/after the run)', () => {
  it('a letter inside/after a unit label extends the run; a still-known label stays attached', () => {
    const five = at(unitn(num(5), 'm'), { kind: 'token', path: [], index: 1 });
    const next = typeToken(five, s('m'));
    expectTree(next, unitn(num(5), 'mm'));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 2 });
    expectLegal(next);
  });

  it('an unknown grown label reverts to the ordinary symbol pair (the derived reversion)', () => {
    const it = at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 2 });
    const next = typeToken(it, s('x'));
    expectTree(next, imp(num(50), sym('mmx')));
    expect(next.caret).toEqual({ kind: 'token', path: [1], index: 3 });
    expectLegal(next);
  });

  it('a digit inside/after a unit label extends the run text — no unit has digits, so it reverts', () => {
    const back = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 2 }), d('7'));
    expectTree(back, imp(num(50), sym('mm7')));
    expect(back.caret).toEqual({ kind: 'token', path: [1], index: 3 });
    const mid = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 1 }), d('7'));
    expectTree(mid, imp(num(50), sym('m7m')));
    expect(mid.caret).toEqual({ kind: 'token', path: [1], index: 2 });
  });

  it('a digit at the label FRONT (no letters to its left) pairs as a number before the unit', () => {
    const next = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 0 }), d('7'));
    expectTree(next, imp(num(7), unitn(num(50), 'mm')));
    expectLegal(next);
  });

  it('letters glue into the label from both shared-gap sides (known stays, unknown reverts)', () => {
    // from the seam directly AFTER a unit cell: the run extends behind
    const back = typeToken(at(add(unitn(num(5), 'm'), num(2)), { kind: 'row', path: [], index: 1 }), s('m'));
    expectTree(back, add(unitn(num(5), 'mm'), num(2)));
    expect(back.caret).toEqual({ kind: 'row', path: [], index: 1 });
    const backRevert = typeToken(at(add(unitn(num(5), 'm'), num(2)), { kind: 'row', path: [], index: 1 }), s('z'));
    expectTree(backRevert, add(imp(num(5), sym('mz')), num(2)));
    expectLegal(backRevert);
    // from the seam directly BEFORE a unit cell: the run extends at its front
    const front = typeToken(at(add(num(2), unitn(num(5), 'm')), { kind: 'row', path: [], index: 1 }), s('m'));
    expectTree(front, add(num(2), unitn(num(5), 'mm'))); // still known: the unit keeps its knot
    expect(front.caret).toEqual({ kind: 'token', path: [1], index: 1 });
    const frontRevert = typeToken(at(add(num(2), unitn(num(5), 'm')), { kind: 'row', path: [], index: 1 }), s('x'));
    expectTree(frontRevert, add(num(2), imp(num(5), sym('xm')))); // unknown: the front-glued run reverts to a symbol pair
    expect(frontRevert.caret).toEqual({ kind: 'token', path: [1, 1], index: 1 });
    expectLegal(front);
  });

  it('Space inside a unit label breaks the run apart — the value and two plain symbols', () => {
    const next = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 1 }), { t: 'space' });
    expectTree(next, imp(num(50), sym('m'), sym('m')));
    expect(next.caret).toEqual({ kind: 'row', path: [], index: 2 });
    expectLegal(next);
    // and the break is permanent: the 3-cell shape is not a convertible pair
    expect(settleUnits(next)).toBe(next);
  });

  it('the structure keys grab an attached unit whole at its label edges (mid-label: silent no-op)', () => {
    const slashed = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 2 }), divide);
    expectTree(slashed, { type: 'frac', num: unitn(num(50), 'mm'), den: null });
    expect(slashed.caret).toEqual({ kind: 'slot', path: [], slot: 'den' });
    const opAt = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 2 }), plus);
    expectTree(opAt, add(unitn(num(50), 'mm'), null));
    const mid = typeToken(at(unitn(num(50), 'mm'), { kind: 'token', path: [], index: 1 }), plus);
    expectTree(mid, unitn(num(50), 'mm')); // unrepresentable halves: silent no-op
  });

  it('typeToken never settles on letters — the engine surface stays one token one op', () => {
    const state = typedRun();
    const logLen = state.log.length;
    const next = typeToken(state, s('s')); // one more letter: still the pair, one log entry
    expectTree(next, imp(num(50), sym('mms')));
    expect(next.log.length).toBe(logLen + 1);
    expect(settleUnits(state)).not.toBe(state); // the leave is the CONTROLLER's call
  });
});

describe('S-104 — unit label token carets (N1 letter-wise positions)', () => {
  it('Left/Right step letter-wise through the label and exit at both ends', () => {
    const env: Envelope = { v: 1, root: add(num(1), unitn(num(50), 'mm'), num(9)) };
    const inLabel: Caret = { kind: 'token', path: [1], index: 1 };
    expect(resolveMove(env, inLabel, 'left')).toEqual({ kind: 'token', path: [1], index: 0 });
    expect(resolveMove(env, inLabel, 'right')).toEqual({ kind: 'token', path: [1], index: 2 });
    // exits: the label start leaves left, the label end leaves right
    // 4a re-pin (N1 exit + OA-visual-trumps): the exits cross the glyphs to
    // the adjacent cells' bench stations — offset 0 of 1, the in-token end of 9
    expect(resolveMove(env, { kind: 'token', path: [1], index: 0 }, 'left')).toEqual({ kind: 'token', path: [0], index: 1 });
    expect(resolveMove(env, { kind: 'token', path: [1], index: 2 }, 'right')).toEqual({ kind: 'token', path: [2], index: 0 });
  });

  it('the caret union addresses the label exactly (bounds checked, labels sub-only)', () => {
    const env: Envelope = { v: 1, root: unitn(num(50), 'mm') };
    expect(caretResolvesIn(env, { kind: 'token', path: [], index: 2 })).toBe(true);
    expect(caretResolvesIn(env, { kind: 'token', path: [], index: 3 })).toBe(false);
    // the `label` discriminator belongs to sub nodes only
    expect(caretResolvesIn(env, { kind: 'token', path: [], index: 1, label: 'sub' } as Caret)).toBe(false);
    // an empty label answers offset 0 (the incomplete unit-label state)
    expect(caretResolvesIn({ v: 1, root: unitn(num(1), '') }, { kind: 'token', path: [], index: 0 })).toBe(true);
  });
});

describe('integration — the leave chain through the controller-shaped flow', () => {
  it('`50mm` then + (a non-letter leave): settle first, then the operator wraps the unit', () => {
    const leave = typeToken(settleUnits(typedRun()), plus);
    expectTree(leave, add(unitn(num(50), 'mm'), null));
    expect(leave.caret).toEqual({ kind: 'row', path: [], index: 1 });
    expectLegal(leave);
  });

  it('`50mm` then SPACE: the settle fires before the boundary arm', () => {
    const leave = typeToken(settleUnits(typedRun()), space);
    expectTree(leave, unitn(num(50), 'mm'));
    expect((leave.caret as { boundary?: true }).boundary).toBe(true);
  });

  it('a custom vocabulary drives the conversion (session units, never the default)', () => {
    const vocab = { constants: [], units: ['fqt'], functions: [] };
    const seed: EditingState = {
      ...initSession({ v: 1, root: imp(num(1), sym('mm')) }, vocab),
    };
    expect(settleUnits(seed)).toBe(seed); // mm is not a unit of THIS session
    const convertible: EditingState = {
      ...initSession({ v: 1, root: imp(num(1), sym('fqt')) }, vocab),
    };
    expectTree(settleUnits(convertible), unitn(num(1), 'fqt'));
  });
});
