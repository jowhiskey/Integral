// In-token leaf caret (DOM-arc session 3, engine side): the `token` caret
// variant inside number tokens only — validity (caretResolvesIn), Left/Right
// character stepping with structural exits at the ends, vertical keys via the
// owning structural station, splice/replace relocation interplay, and typing at
// in-token positions (digit merge at the offset, structure-token split, snap).
// Every intermediate state is pinned fromJSON-legal with a resolving caret.

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';

import {
  applyOp,
  caretResolves,
  caretResolvesIn,
  envelopeOf,
  EngineError,
  initSession,
  resolveMove,
  typeToken,
  undo,
  type Caret,
  type EditingState,
} from '../src/engine/index.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const row = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const token = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const j = (x: unknown): string => JSON.stringify(x);

/** The engine-arc oracle pattern: the envelope re-parses through fromJSON and
 *  the caret resolves in it. */
function legal(state: EditingState): void {
  const env = envelopeOf(state);
  fromJSON(env);
  expect(caretResolves(state.root, state.caret)).toBe(true);
}

/** Accepts a bare root node or a full envelope. */
const wrap = (x: unknown): unknown =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && (x as { v?: unknown }).v === 1 ? x : { v: 1, root: x };
const envOf = (seed: unknown) => envelopeOf(initSession(wrap(seed)));
/** A session at a given caret without logging (movement/moveCaret placement). */
const at = (seed: unknown, caret: Caret): EditingState => ({ ...initSession(wrap(seed)), caret });

describe('token caret validity (caretResolvesIn)', () => {
  const env = envOf(num(123));
  it('accepts offsets 0..len on a num, rejects beyond / fractional / non-num / empty formula', () => {
    expect(caretResolvesIn(env, token([], 0))).toBe(true);
    expect(caretResolvesIn(env, token([], 3))).toBe(true);
    expect(caretResolvesIn(env, token([], 4))).toBe(false);
    expect(caretResolvesIn(env, token([], -1))).toBe(false);
    expect(caretResolvesIn(env, token([], 1.5))).toBe(false);
    // rework 2a: symbols are in-token tokens too (T3 glue/split at offsets)
    expect(caretResolvesIn(envOf(sym('ab')), token([], 1))).toBe(true);
    expect(caretResolvesIn(envOf(sym('ab')), token([], 2))).toBe(true); // offset len is legal
    expect(caretResolvesIn(envOf(sym('ab')), token([], 3))).toBe(false);
    // non-token nodes still carry no in-token offsets
    expect(caretResolvesIn(envOf({ v: 1, root: { type: 'group', parens: 'always', child: sym('a') } }), token([], 0))).toBe(false);
    expect(caretResolvesIn(envOf({ v: 1, root: null }), token([], 0))).toBe(false);
    expect(caretResolvesIn(envOf({ v: 1, root: { type: 'frac', num: num(12), den: null } }), token(['num'], 2))).toBe(true);
    expect(caretResolvesIn(envOf({ v: 1, root: { type: 'frac', num: num(12), den: null } }), token(['den'], 0))).toBe(false); // null slot
  });
});

describe('in-token movement (resolveMove / move op)', () => {
  it('Left/Right step one character inside a number; the ends exit to the adjacent structural stations', () => {
    const env = envOf({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), num(123), sym('b')] } });
    // stepping inside the token at cell 1
    expect(resolveMove(env, token([1], 1), 'left')).toEqual(token([1], 0));
    expect(resolveMove(env, token([1], 1), 'right')).toEqual(token([1], 2));
    expect(resolveMove(env, token([1], 2), 'right')).toEqual(token([1], 3));
    // exits (4a re-pin, OA-visual-trumps benches): offset 0 + Left crosses the
    // glyph to cell 0's in-token END; offset len + Right crosses to cell 2's
    // offset 0 — one visible movement per press (N1's exit rule)
    expect(resolveMove(env, token([1], 0), 'left')).toEqual(token([0], 1));
    expect(resolveMove(env, token([1], 3), 'right')).toEqual(token([2], 0));
    // a node caret on the num takes the same exit climbs (bench stations)
    expect(resolveMove(env, node([1]), 'left')).toEqual(token([0], 1));
    expect(resolveMove(env, node([1]), 'right')).toEqual(token([2], 0));
    // a lone root num: token ends have no exit (document edge)
    const rootEnv = envOf(num(42));
    expect(resolveMove(rootEnv, token([], 0), 'left')).toBe(null);
    expect(resolveMove(rootEnv, token([], 2), 'right')).toBe(null);
    expect(resolveMove(rootEnv, token([], 1), 'left')).toEqual(token([], 0));
    expect(resolveMove(rootEnv, token([], 1), 'right')).toEqual(token([], 2));
  });

  it('vertical keys from an in-token position behave like the owning structural station', () => {
    const env = envOf({ v: 1, root: { type: 'frac', num: num(12), den: num(3) } });
    expect(resolveMove(env, token(['num'], 1), 'down')).toEqual(resolveMove(env, node(['num']), 'down'));
    // 4a re-pin (OA-vertical-default): vertical arrival rests at the region
    // content END — the in-token end, never a station ON the content node
    expect(resolveMove(env, token(['num'], 1), 'down')).toEqual(token(['den'], 1));
    expect(resolveMove(env, token(['den'], 0), 'up')).toEqual(token(['num'], 2));
    // pow: base up → exp (the raised-script edge)
    const powEnv = envOf({ v: 1, root: { type: 'pow', base: num(2), exp: num(10) } });
    expect(resolveMove(powEnv, token(['base'], 1), 'up')).toEqual(token(['exp'], 2));
    expect(resolveMove(powEnv, token(['exp'], 1), 'down')).toEqual(token(['base'], 1));
  });

  it('the move op carries token carets, never logs, and no-target moves are the same state', () => {
    let state = at({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), num(123), sym('b')] } }, token([1], 1));
    const before = state;
    state = applyOp(state, { op: 'move', dir: 'right' });
    expect(state.caret).toEqual(token([1], 2));
    expect(state.log).toBe(before.log); // movement never logs
    legal(state);
    const moved = applyOp(state, { op: 'move', dir: 'left' });
    expect(moved.caret).toEqual(token([1], 1));
    // exit at the end, then a no-op at the document edge returns the same object
    let s2 = applyOp(moved, { op: 'move', dir: 'left' }); // token([1],0)
    s2 = applyOp(s2, { op: 'move', dir: 'left' }); // exits across the glyph to a's end
    expect(s2.caret).toEqual(token([0], 1));
    const s3 = applyOp(at(num(5), token([], 0)), { op: 'move', dir: 'left' });
    expect(s3.caret).toEqual(token([], 0));
  });
});

describe('token caret interplay with the mechanical ops', () => {
  it('row splices shift the token caret with its address; deleting the num falls back to the seam', () => {
    let state = at({ v: 1, root: { type: 'op', op: 'add', args: [num(12), sym('b')] } }, token([0], 1));
    state = applyOp(state, { op: 'insert', node: sym('z'), at: { at: 'row', path: [], index: 0 } });
    expect(state.caret).toEqual(token([1], 1)); // shifted with the splice
    legal(state);
    state = applyOp(state, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } }); // delete the num cell
    expect(state.caret).toEqual(row([], 1)); // fell back to the seam in the freed spot
    legal(state);
  });

  it('replacing the num keeps the in-token offset; a longer replacement advances the caret one (merge), a shorter keeps it (peel)', () => {
    // grow: 12 → 132 (caret at offset 1 advances to 2)
    let state = at(num(12), token([], 1));
    state = applyOp(state, { op: 'insert', node: num(132), at: { at: 'replaceRoot' } });
    expect(state.caret).toEqual(token([], 2));
    legal(state);
    // shrink: 132 → 13 (caret at offset 2 keeps its offset, clamped to len 2)
    state = applyOp(state, { op: 'insert', node: num(13), at: { at: 'replaceRoot' } });
    expect(state.caret).toEqual(token([], 2));
    // shrink below the offset clamps
    state = at(num(132), token([], 3));
    state = applyOp(state, { op: 'insert', node: num(1), at: { at: 'replaceRoot' } });
    expect(state.caret).toEqual(token([], 1));
    legal(state);
    // a non-num replacement dives (the token position does not survive a structural replace)
    state = applyOp(at(num(12), token([], 1)), {
      op: 'insert',
      node: { type: 'op', op: 'add', args: [num(1), null] },
      at: { at: 'replaceRoot' },
    });
    expect(state.caret).toEqual(row([], 1)); // dive to the wrapper's first empty cell
    legal(state);
  });
});

describe('typing at in-token positions (Task 5)', () => {
  it('a digit merges into the number at the offset — one op, one log entry, caret advances in-token', () => {
    // offset len (append): 12 + '3' → 123
    let state = at(num(12), token([], 2));
    state = typeToken(state, { t: 'leaf', node: num(3) });
    expect(j(envelopeOf(state).root)).toBe(j(num(123)));
    expect(state.caret).toEqual(token([], 3));
    expect(state.log.length).toBe(1);
    legal(state);
    // interior: 123 + '9' at offset 1 → 1923, caret token offset 2
    state = typeToken(at(num(123), token([], 1)), { t: 'leaf', node: num(9) });
    expect(j(envelopeOf(state).root)).toBe(j(num(1923)));
    expect(state.caret).toEqual(token([], 2));
    legal(state);
    // offset 0 (prepend): 12 + '3' → 312, caret offset 1
    state = typeToken(at(num(12), token([], 0)), { t: 'leaf', node: num(3) });
    expect(j(envelopeOf(state).root)).toBe(j(num(312)));
    expect(state.caret).toEqual(token([], 1));
    legal(state);
    // inside a row cell
    state = typeToken(at({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), num(12)] } }, token([1], 1)), {
      t: 'leaf',
      node: num(5),
    });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), num(152)] }));
    expect(state.caret).toEqual(token([1], 2));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('a structure token at an interior offset splits the number: left half = attach context, right half after — one op', () => {
    // 12|3 + '+' → 12+3
    let state = typeToken(at(num(123), token([], 2)), { t: 'operator', fn: 'add' });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [num(12), num(3)] }));
    // 4a re-pin (OA-visual-trumps/N2): the station directly after the glyph IS
    // the right half's offset 0 — one visible spot, one state
    expect(state.caret).toEqual(token([1], 0));
    expect(state.log.length).toBe(1);
    legal(state);
    // 1|23 + '/' → frac(1, 23) — T7 re-pin (rework 2b-1): the owner's uniform
    // split ruling (2026-11-09) now governs mid-token structure keys — left of
    // the caret = numerator, right = denominator — so the 2a minimal-path
    // envelope shape STANDS, and the caret pins to the ruled start-of-right-slot.
    state = typeToken(at(num(123), token([], 1)), { t: 'divide' });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: num(1), den: num(23) }));
    expect(state.caret).toEqual(token(['den'], 0)); // before the right half's content (T7 ruled caret)
    legal(state);
    // 12|3 + '^' → pow(12, 3) — same T7 re-pin, on the power side.
    state = typeToken(at(num(123), token([], 2)), { t: 'pow' });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'pow', base: num(12), exp: num(3) }));
    expect(state.caret).toEqual(token(['exp'], 0));
    legal(state);
    // split inside a row cell: a + 12|3 with '*' nests in the right operand: a + 12*3
    state = typeToken(at({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), num(123)] } }, token([1], 2)), {
      t: 'operator',
      fn: 'multiply',
    });
    expect(j(envelopeOf(state).root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('a'), { type: 'op', op: 'multiply', args: [num(12), num(3)] }] }),
    );
    expect(state.log.length).toBe(1);
    legal(state);
    // same-op chain extends: a + 1|23 with '+' → a + 1 + 23 (one flat chain)
    state = typeToken(at({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), num(123)] } }, token([1], 1)), {
      t: 'operator',
      fn: 'add',
    });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), num(1), num(23)] }));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('boundary offsets: len wraps right ([token, null]); 0 leads ([null, token]) — T1/S-003', () => {
    // offset 0: a leading glyph (`|123` + `+` → `+|123`)
    let state = typeToken(at(num(123), token([], 0)), { t: 'operator', fn: 'add' });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [null, num(123)] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
    // offset len: the trailing pending cell (`123|` + `+` → `123+|`)
    state = typeToken(at(num(123), token([], 3)), { t: 'operator', fn: 'add' });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [num(123), null] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
  });

  it('rework 2a: letters split a number, groups juxtapose-split a token, mid-row glyphs split the cell', () => {
    // a letter inside a number → S-031's flat number·symbol·number juxtaposition
    const l = typeToken(at(num(12), token([], 1)), { t: 'leaf', node: sym('x') });
    expect(j(envelopeOf(l).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(1), sym('x'), num(2)], implicit: true }),
    );
    // 4a re-pin (OA-token-end): the typed x's in-token end
    expect(l.caret).toEqual(token([1], 1));
    legal(l);
    // groupOpen at an interior offset: the T6 group juxtaposes between the halves
    const g = typeToken(at(num(123), token([], 1)), { t: 'groupOpen' });
    expect(j(envelopeOf(g).root)).toBe(
      j({
        type: 'op',
        op: 'multiply',
        args: [num(1), { type: 'group', parens: 'always', child: null }, num(23)],
        implicit: true,
      }),
    );
    legal(g);
    // a mid-row number's interior glyph splits its cell (no swap under literal insertion)
    const env = { v: 1, root: { type: 'op', op: 'add', args: [num(123), sym('b')] } };
    const sp = typeToken(at(env, token([0], 1)), { t: 'operator', fn: 'multiply' });
    expect(j(envelopeOf(sp).root)).toBe(
      j({ type: 'op', op: 'add', args: [{ type: 'op', op: 'multiply', args: [num(1), num(23)] }, sym('b')] }),
    );
    expect(sp.log.length).toBe(1);
    legal(sp);
    // same-op parent rows extend flat instead (structural rule 3)
    const flat = typeToken(at(env, token([0], 1)), { t: 'operator', fn: 'add' });
    expect(j(envelopeOf(flat).root)).toBe(
      j({ type: 'op', op: 'add', args: [num(1), num(23), sym('b')] }),
    );
    // 4a re-pin (OA-visual-trumps/N2): after the inserted glyph IS the next cell's offset 0
    expect(flat.caret).toEqual(token([1], 0));
    legal(flat);
  });

  it('typing sequences through in-token positions stay legal and undo byte-exactly', () => {
    let state = at(num(1), token([], 1));
    state = typeToken(state, { t: 'leaf', node: num(2) }); // 12
    legal(state);
    state = typeToken(state, { t: 'leaf', node: num(3) }); // 123
    legal(state);
    expect(j(envelopeOf(state).root)).toBe(j(num(123)));
    expect(state.caret).toEqual(token([], 3));
    const undone = undo(state);
    expect(j(envelopeOf(undone).root)).toBe(j(num(12)));
    expect(undone.caret).toEqual(token([], 2));
    legal(undone);
  });
});
