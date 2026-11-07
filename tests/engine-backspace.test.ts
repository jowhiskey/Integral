// Backspace (DOM-arc session 3, engine side): decideBackspace / backspace —
// the ruled matrix: digit-wise peel (in-token, node-caret, seam targets),
// atomic whole-node delete across node kinds and nesting levels, the
// unconditional last-content guard (placeholder first, incl. the
// two-placeholder fraction), structure death at a placeholder (uniform across
// frac/group/op-fn rows/pow/root/unit, nested and at root), Ctrl+Backspace
// whole-node delete under the same guard, and the defined no-op cases. One
// backspace = at most one op = at most one log entry; undo byte-exact; every
// intermediate state fromJSON-legal with a resolving caret.

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';

import {
  backspace,
  caretResolves,
  decideBackspace,
  envelopeOf,
  EngineError,
  initSession,
  undo,
  type Caret,
  type EditingState,
} from '../src/engine/index.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const slot = (path: readonly (number | string)[], s: string): Caret => ({ kind: 'slot', path, slot: s as never });
const row = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const token = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const j = (x: unknown): string => JSON.stringify(x);

/** Oracle pattern: the envelope re-parses through fromJSON; the caret resolves. */
function legal(state: EditingState): void {
  const env = envelopeOf(state);
  fromJSON(env);
  expect(caretResolves(state.root, state.caret)).toBe(true);
}

const wrap = (x: unknown): unknown =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && (x as { v?: unknown }).v === 1 ? x : { v: 1, root: x };
/** A session at a given caret without logging. */
const at = (seed: unknown, caret: Caret): EditingState => ({ ...initSession(wrap(seed)), caret });
/** Re-place the caret on an existing session (no log entry). */
const place = (state: EditingState, caret: Caret): EditingState => ({ ...state, caret });
const envOf = (seed: unknown) => envelopeOf(initSession(wrap(seed)));

describe('digit-wise peel (numbers lose their last digit before the caret)', () => {
  it('in-token: the digit before the offset goes, the caret keeps its in-token offset (clamped)', () => {
    // 123, caret at offset 2 ("12|3") → delete '2' → 13, caret offset 2 ("13|")
    let state = backspace(at(num(123), token([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(num(13)));
    expect(state.caret).toEqual(token([], 2));
    expect(state.log.length).toBe(1);
    legal(state);
    // offset 1 ("1|23") → delete '1' → 23, caret offset 1
    state = backspace(at(num(123), token([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(num(23)));
    expect(state.caret).toEqual(token([], 1));
    legal(state);
    // offset len ("123|") → delete '3' → 12, caret offset 2 (clamped)
    state = backspace(at(num(123), token([], 3)));
    expect(j(envelopeOf(state).root)).toBe(j(num(12)));
    expect(state.caret).toEqual(token([], 2));
    legal(state);
  });

  it('node caret on a number: the last digit goes, the caret stays on the (shortened) node', () => {
    let state = backspace(at(num(42), node([])));
    expect(j(envelopeOf(state).root)).toBe(j(num(4)));
    expect(state.caret).toEqual(node([]));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('row seam after a number cell: the cell number is shortened, the seam caret survives the replace', () => {
    const env = { type: 'op', op: 'add', args: [sym('a'), num(12)] } as const;
    let state = backspace(at(env, row([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), num(1)] }));
    expect(state.caret).toEqual(row([], 2));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('an emptied number is removed with the caret in the freed spot (root / slot / row cell)', () => {
    // root single digit → empty formula
    let state = backspace(at(num(5), node([])));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
    // slot: frac(5, 3), caret on the num → emptied → num slot placeholder, caret in it
    state = backspace(at({ type: 'frac', num: num(5), den: num(3) }, node(['num'])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: num(3) }));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
    // row cell: add(a, 5), seam 2 → emptied → cell spliced, caret at the freed seam
    state = backspace(at({ type: 'op', op: 'add', args: [sym('a'), num(5)] }, row([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a')] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
  });
});

describe('atomic whole-node deletion (every other node kind goes whole, at any nesting level)', () => {
  it('identifiers, subscripts, units, function names, and structures delete whole', () => {
    const env = {
      type: 'op',
      op: 'add',
      args: [sym('a'), { type: 'sub', base: 'x', sub: '1' }, { type: 'unit', value: num(5), unit: 'mm' }, { type: 'fn', name: 'sin', args: [sym('z')] }],
    } as const;
    // delete the sub (node caret on cell 1)
    let state = backspace(at(env, node([1])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), env.args[2], env.args[3]] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
    // delete the unit (whole, value included)
    state = backspace(at(env, node([2])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [env.args[0], env.args[1], env.args[3]] }));
    legal(state);
    // delete the fn name node (whole fn with its args)
    state = backspace(at(env, node([3])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: env.args.slice(0, 3) }));
    legal(state);
    // a whole structure at depth: the group inside a frac numerator
    const nested = {
      type: 'frac',
      num: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('b'), sym('c')] } },
      den: num(2),
    } as const;
    state = backspace(at(nested, node(['num'])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: num(2) }));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
  });

  it('a row seam deletes the cell to its left (whole)', () => {
    const env = { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } as const;
    const state = backspace(at(env, row([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), sym('c')] }));
    expect(state.caret).toEqual(row([], 1));
    expect(state.log.length).toBe(1);
    legal(state);
  });
});

describe('the last-content guard (unconditional — placeholder first, parent never deleted)', () => {
  it('deleting the last content of a slot region yields the placeholder, caret in it — even when every other region is already □', () => {
    // den already □ + the last num child deleted → num becomes □ too; the fraction stays
    let state = backspace(at({ type: 'frac', num: num(5), den: null }, node(['num'])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: null }));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
    // same from the other side: frac(□, 5) — delete the den → frac(□, □)
    state = backspace(at({ type: 'frac', num: null, den: num(5) }, node(['den'])));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: null }));
    expect(state.caret).toEqual(slot([], 'den'));
    legal(state);
  });

  it('a row that loses its last content cell becomes the empty row (renders one □), never deleted by the peel', () => {
    const state = backspace(at({ type: 'op', op: 'add', args: [num(5)] }, row([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [] }));
    expect(state.caret).toEqual(row([], 0));
    legal(state);
  });
});

describe('structure death — the only path that deletes a parent (backspace AT a placeholder)', () => {
  it('fires iff every region of the parent is an empty placeholder; caret in the freed spot at the parent’s former position', () => {
    // fraction with two placeholders, at root — fires from either region's placeholder
    const bothEmpty = { type: 'frac', num: null, den: null } as const;
    for (const c of [slot([], 'num'), slot([], 'den')]) {
      const state = backspace(at(bothEmpty, c));
      expect(j(envelopeOf(state).root)).toBe('null');
      expect(state.caret).toEqual({ kind: 'empty' });
      expect(state.log.length).toBe(1);
      legal(state);
    }
    // while any region has content it is a no-op
    let state = backspace(at({ type: 'frac', num: null, den: num(3) }, slot([], 'num')));
    expect(state.caret).toEqual(slot([], 'num'));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: num(3) }));
    expect(state.log.length).toBe(0);
    // group
    state = backspace(at({ type: 'group', parens: 'always', child: null }, slot([], 'child')));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    // pow: both placeholders → death; one filled → no-op
    state = backspace(at({ type: 'pow', base: null, exp: null }, slot([], 'exp')));
    expect(j(envelopeOf(state).root)).toBe('null');
    state = backspace(at({ type: 'pow', base: null, exp: num(2) }, slot([], 'base')));
    expect(state.log.length).toBe(0);
    // square root (index not applicable): radicand placeholder → death; indexed root with content index → no-op
    state = backspace(at({ type: 'root', radicand: null }, slot([], 'radicand')));
    expect(j(envelopeOf(state).root)).toBe('null');
    state = backspace(at({ type: 'root', radicand: null, index: num(3) }, slot([], 'radicand')));
    expect(state.log.length).toBe(0);
    // unit with empty value
    state = backspace(at({ type: 'unit', value: null, unit: 'mm' }, slot([], 'value')));
    expect(j(envelopeOf(state).root)).toBe('null');
    // op row: single null cell → death; a content cell anywhere → no-op; empty row → death
    state = backspace(at({ type: 'op', op: 'add', args: [null] }, row([], 0)));
    expect(j(envelopeOf(state).root)).toBe('null');
    state = backspace(at({ type: 'op', op: 'add', args: [sym('a'), null] }, row([], 1)));
    expect(state.log.length).toBe(0);
    state = backspace(at({ type: 'op', op: 'add', args: [] }, row([], 0)));
    expect(j(envelopeOf(state).root)).toBe('null');
    // fn row
    state = backspace(at({ type: 'fn', name: 'sin', args: [null] }, row([], 0)));
    expect(j(envelopeOf(state).root)).toBe('null');
    state = backspace(at({ type: 'fn', name: 'sin', args: [sym('x'), null] }, row([], 1)));
    expect(state.log.length).toBe(0);
  });

  it('nested structure death: the parent dies at its own position, the caret lands in the freed spot of the grandparent', () => {
    const env = { type: 'op', op: 'add', args: [sym('a'), { type: 'frac', num: null, den: null }] } as const;
    const state = backspace(at(env, slot([1], 'den')));
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a')] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
    // inside a slot: frac(frac(□,□), 2) — the inner frac dies, the outer den keeps the freed slot
    const env2 = { type: 'frac', num: { type: 'frac', num: null, den: null }, den: num(2) } as const;
    const state2 = backspace(at(env2, slot(['num'], 'num')));
    expect(j(envelopeOf(state2).root)).toBe(j({ type: 'frac', num: null, den: num(2) }));
    expect(state2.caret).toEqual(slot([], 'num'));
    legal(state2);
  });
});

describe('Ctrl+Backspace — whole-node delete under the same guard', () => {
  it('in-token: the whole number; node caret: the whole node; seam: the whole cell left — one op each', () => {
    // whole number from an in-token caret
    let state = backspace(at(num(123), token([], 1)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(1);
    legal(state);
    // node caret on a multi-digit number: whole, not digit-wise
    state = backspace(at(num(123), node([])), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe('null');
    legal(state);
    // seam: whole cell even when it is a number
    state = backspace(at({ type: 'op', op: 'add', args: [sym('a'), num(12)] }, row([], 2)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'op', op: 'add', args: [sym('a')] }));
    expect(state.caret).toEqual(row([], 1));
    legal(state);
  });

  it('a Ctrl+Backspace removing the last content of a region yields the placeholder first (guard applies)', () => {
    const state = backspace(at({ type: 'frac', num: num(12), den: num(3) }, node(['num'])), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: num(3) }));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
  });
});

describe('defined no-op cases (never destroy structure)', () => {
  it('empty formula, row seam 0, in-token offset 0, empty cell left of a seam, placeholder with content elsewhere', () => {
    const cases: [unknown, Caret][] = [
      [{ v: 1, root: null }, { kind: 'empty' }],
      [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }, row([], 0)],
      [num(123), token([], 0)],
      [{ type: 'op', op: 'add', args: [sym('a'), null] }, row([], 2)], // null cell left of the seam
      [{ type: 'frac', num: num(5), den: null }, slot([], 'den')], // num has content
    ];
    for (const [seed, caret] of cases) {
      const before = at(seed, caret);
      const after = backspace(before);
      expect(after).toBe(before); // same state object — nothing applied, nothing logged
      expect(j(envelopeOf(after))).toBe(j(envelopeOf(before)));
    }
  });
});

describe('decision purity, logging, undo', () => {
  it('decideBackspace is pure (no application) and reports kind/ops/caret; caret-invalid throws typed', () => {
    const env = envOf({ type: 'frac', num: num(12), den: null });
    const d = decideBackspace(env, node(['num']));
    expect(d.kind).toBe('shorten');
    expect(d.ops.length).toBe(1);
    expect(d.ops[0]).toEqual({ op: 'insert', node: num(1), at: { at: 'replaceSlot', path: [], slot: 'num' } });
    expect(d.caret).toEqual(node(['num']));
    expect(j(env.root)).toBe(j({ type: 'frac', num: num(12), den: null })); // untouched
    expect(() => decideBackspace(envOf(num(1)), token([], 9))).toThrowError(EngineError);
    expect(() => decideBackspace(envOf(num(1)), token([], 9))).toThrowError(/caret-invalid|does not resolve/);
  });

  it('one backspace = one op = one log entry; undo restores tree and caret byte-exactly', () => {
    let state = at({ type: 'frac', num: num(12), den: num(3) }, node(['num']));
    const logBefore = state.log.length;
    state = backspace(state); // 12 → 1
    expect(state.log.length).toBe(logBefore + 1);
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: num(1), den: num(3) }));
    const undone = undo(state);
    expect(j(envelopeOf(undone).root)).toBe(j({ type: 'frac', num: num(12), den: num(3) }));
    expect(undone.caret).toEqual(node(['num']));
    legal(undone);
  });

  it('the full peel chain on a fraction: digits → emptied → placeholder → (content elsewhere: no-op) → two placeholders → structure death', () => {
    let state = at({ type: 'frac', num: num(12), den: num(3) }, node(['num']));
    state = backspace(state); // 12 → 1
    legal(state);
    state = backspace(state); // 1 → emptied → num □
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: num(3) }));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
    state = backspace(state); // placeholder, den has content → no-op
    expect(state.log.length).toBe(2);
    // now kill the den too: frac(□, □)
    state = backspace(place(state, node(['den']))); // 3 → emptied → den □
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'frac', num: null, den: null }));
    expect(state.caret).toEqual(slot([], 'den'));
    legal(state);
    state = backspace(state); // structure death at the placeholder
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(4); // peel, peel, peel(den), death — the no-op logged nothing
    legal(state);
    // undo walks the chain back byte-exactly
    let s = state;
    for (let i = 0; i < 4; i++) s = undo(s);
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'frac', num: num(12), den: num(3) }));
    expect(s.caret).toEqual(node(['num']));
    expect(s.log.length).toBe(0);
  });
});
