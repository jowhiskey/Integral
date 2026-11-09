// Forward Delete (rework session 3) — the ruled mirrors of D1/D3 (D1: the
// character right of the caret goes, the caret stays put; at a gap the
// right-adjacent token's FIRST character; D3/Ctrl: everything right within
// the token, the whole right-adjacent token at a gap) + the NAMED silent
// no-op defaults where the contract rules no forward mirror (the D4
// rejection pattern, called out per case): Del at a □ slot, Del facing a
// fenceless structure / fenced container / nested row, Del at dangling
// operator glyphs and pending cells, Del past the last token. One Del = at
// most one op = one log entry; every state fromJSON-legal.

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';

import {
  caretResolves,
  decideDelete,
  forwardDelete,
  envelopeOf,
  initSession,
  type Caret,
  type EditingState,
} from '../src/engine/index.js';

const num = (value: number, dot?: true) => ({ type: 'num', value, ...(dot ? { dot: true } : {}) });
const sym = (name: string) => ({ type: 'sym', name });
const sub = (base: string, subscript: string) => ({ type: 'sub', base, sub: subscript });
const unitNode = (value: unknown, u: string) => ({ type: 'unit', value: value as never, unit: u });
const fence = () => ({ type: 'fence', side: 'close' });
const op = (name: string, ...args: (unknown | null)[]) => ({ type: 'op', op: name, args });
const fn = (name: string, args: (unknown | null)[]) => ({ type: 'fn', name, args });
const group = (child: unknown) => ({ type: 'group', parens: 'always', child });
const frac = (n: unknown, d: unknown) => ({ type: 'frac', num: n, den: d });
const jmp = (...args: (unknown | null)[]) => ({ type: 'op', op: 'multiply', args, implicit: true });

const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const tokc = (path: readonly (number | string)[], index: number, label?: 'base' | 'sub'): Caret =>
  label === undefined ? { kind: 'token', path, index } : { kind: 'token', path, index, label };

const j = (x: unknown): string => JSON.stringify(x);

function legal(state: EditingState): void {
  fromJSON(envelopeOf(state));
  expect(caretResolves(state.root, state.caret)).toBe(true);
}

const wrap = (x: unknown): unknown =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && (x as { v?: unknown }).v === 1 ? x : { v: 1, root: x };
const at = (seed: unknown, caret: Caret): EditingState => ({ ...initSession(wrap(seed)), caret });
const envOf = (seed: unknown) => envelopeOf(initSession(wrap(seed)));

describe('Forward Delete — the D1 mirror in tokens (the char right of the caret, caret stays put)', () => {
  it('symbols and numbers lose the character AT the caret, the caret keeps its offset', () => {
    let state = forwardDelete(at(sym('abcd'), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(sym('acd')));
    expect(state.caret).toEqual(tokc([], 1));
    expect(state.log.length).toBe(1);
    legal(state);
    state = forwardDelete(at(num(125), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(num(15)));
    legal(state);
  });

  it('unit labels mirror granularly (S-104): 50|mm + Del → 50|m (re-validation per the 2b-2 rule)', () => {
    let state = forwardDelete(at(unitNode(num(50), 'mm'), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(unitNode(num(50), 'm')));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
    // an unknown remainder reverts to the pair (Pa minus a leaves P — not a unit)
    state = forwardDelete(at(unitNode(num(50), 'Pa'), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(num(50), sym('P'))));
    legal(state);
  });

  it('sub labels mirror label-wise (T9); the dot-flag clears when the dot goes; a single-char gap mirror removes the node', () => {
    let state = forwardDelete(at(sub('x', 'abc'), tokc([], 1, 'sub')));
    expect(j(envelopeOf(state).root)).toBe(j(sub('x', 'ac')));
    expect(state.caret).toEqual(tokc([], 1, 'sub'));
    legal(state);
    // the trailing dot goes and the flag with it (5.| + Del → 5|)
    state = forwardDelete(at(num(5, true), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(num(5)));
    legal(state);
    // a single character right of a gap: the node dies (the freed pending cell)
    state = forwardDelete(at(op('add', sym('x'), sym('y')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });
});

describe("Forward Delete at the gap (the D2 mirror: the right-adjacent token FIRST character / the D3 whole)", () => {
  it('x + |abc → x + bc (the first char right of the station; the station caret survives)', () => {
    const state = forwardDelete(at(op('add', sym('x'), sym('abc')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), sym('bc'))));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('the node caret on a leaf is its right edge: the FORWARD gap follows (a|bc → a|c through the pair)', () => {
    const state = forwardDelete(at(jmp(sym('a'), sym('bc')), node([0])));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('a'), sym('c'))));
    legal(state);
  });

  it('a dangling close-fence token dies whole (a movable glyph token, C4)', () => {
    const state = forwardDelete(at(jmp(sym('b'), fence()), rowc([], 1)));
    expect(j(envelopeOf(state).root)).not.toContain('fence');
    legal(state);
  });
});

describe('Forward Ctrl+Delete (the D3 mirror)', () => {
  it('everything RIGHT within the token goes (text[0..index) survives, the caret keeps its offset)', () => {
    const state = forwardDelete(at(sym('abcd'), tokc([], 2)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(sym('ab')));
    expect(state.caret).toEqual(tokc([], 2));
    legal(state);
  });

  it('the whole right-adjacent token at a gap (S-071 mirror) — the freed position the pending null', () => {
    const state = forwardDelete(at(op('add', sym('x'), sym('abc')), rowc([], 1)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('a single-character Ctrl+Del beyond the token end reaches the next right-adjacent token whole', () => {
    const state = forwardDelete(at(sym('ab'), tokc([], 2)), { ctrl: true });
    // the root token has nothing right — a named no-op at the document edge (N3 mirror)
    expect(j(envelopeOf(state).root)).toBe(j(sym('ab')));
    legal(state);
  });
});

describe('Forward Delete — the NAMED silent no-op defaults (unruled mirrors, the D4 rejection pattern)', () => {
  it('Del at a □ slot inside a structure: [named no-op — unruled forward]', () => {
    const seed = frac(sym('a'), null);
    const d = decideDelete(envOf(seed), { kind: 'slot', path: [], slot: 'den' as never });
    expect(d.kind).toBe('noop');
  });

  it('Del facing a fenceless structure (the D5 forward mirror is unruled): x + |frac — silent no-op', () => {
    const seed = op('add', sym('x'), frac(num(1), num(2)));
    const d = decideDelete(envOf(seed), rowc([], 1));
    expect(d.kind).toBe('noop');
    const state = forwardDelete(at(seed, rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(seed));
    expect(state.log.length).toBe(0);
  });

  it('Del facing a fenced container / a nested row: named no-ops (the D7/D8 forward mirrors are unruled)', () => {
    expect(decideDelete(envOf(op('add', sym('x'), group(op('add', sym('a'), sym('b'))))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), fn('sin', [sym('a')]))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), op('multiply', sym('a'), sym('b')))), rowc([], 1)).kind).toBe('noop');
  });

  it('Del at a dangling operator glyph / a pending cell / the row end: named no-ops (the S-066 back-mirror is unruled)', () => {
    expect(decideDelete(envOf(op('add', sym('x'), null)), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), sym('y'))), rowc([], 2)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', null, null)), rowc([], 1)).kind).toBe('noop');
  });

  it('Del on the empty formula: the D4 no-op (S-078 covers both keys)', () => {
    let state = at(null, { kind: 'empty' });
    const after = forwardDelete(state);
    expect(after).toBe(state);
  });

  it('the fn arguments mirror the gap rule for TEXT tokens; comma-crossing matches the collapsed station', () => {
    const state = forwardDelete(at(fn('sin', [sym('ab'), sym('c')]), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('ab'), null]))); // c had one char — the freed arg is the □
    legal(state);
  });
});
