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
  applyOps,
  backspace,
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
    // OA-sub-label-empty forward mirror (rec-mwesfxub-7): Del at the script's
    // last char shrinks to the EMPTY label (the □ state) — not a no-op
    state = forwardDelete(at(sub('x', '5'), tokc([], 0, 'sub')));
    expect(j(envelopeOf(state).root)).toBe(j(sub('x', '')));
    expect(state.caret).toEqual(tokc([], 0, 'sub'));
    legal(state);
    // the trailing dot goes and the flag with it (5.| + Del → 5|)
    state = forwardDelete(at(num(5, true), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(num(5)));
    legal(state);
    // a single character right of a gap: the node dies (the freed pending cell)
    // (at a FILLED seam the glyph stands LEFT of the caret — that is
    // Backspace's territory; Del keeps the D1 mirror here)
    state = forwardDelete(at(op('add', sym('x'), sym('y')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });
});

describe("Forward Delete at the gap (the D2 mirror: the right-adjacent token FIRST character / the D3 whole)", () => {
  it('x + |abc → x + bc (D1 mirror at a filled seam); OA-del-glyph fires only LEFT-of-glyph — in a pending cell', () => {
    const state = forwardDelete(at(op('add', sym('x'), sym('abc')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), sym('bc'))));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // the D1 mirror still holds on a glyph-less (implicit) seam: first char right of the station
    const gl = forwardDelete(at({ type: 'op', op: 'multiply', args: [sym('x'), sym('abc')], implicit: true }, rowc([], 1)));
    expect(j(envelopeOf(gl).root)).toBe(j({ type: 'op', op: 'multiply', args: [sym('x'), sym('bc')], implicit: true }));
    expect(gl.caret).toEqual(rowc([], 1));
    legal(gl);
    // OA-del-glyph (corrected reading, owner fix round): the caret IN a pending
    // null cell faces the dangling glyph to its RIGHT — Del removes it:
    // `|x+1/2` → DEL → `|+1/2` → DEL → `|1/2`
    const stall = forwardDelete(at(op('add', null, frac(num(1), num(2))), rowc([], 0)));
    expect(j(envelopeOf(stall).root)).toBe(j(frac(num(1), num(2)))); // the + and its pending cell splice away
    // re-pinned 2026-11-11 (OA-promote-border, log rec-mwcb8j6u-7): the promoted
    // fraction lands at its LEFT border station — in front of it, never inside
    // the numerator (the old tokc(['num'], 0) landing was the reported bug)
    expect(stall.caret).toEqual({ kind: 'node', path: [], side: 'left' });
    legal(stall);
  });

  it('the node caret on a leaf is its right edge: the FORWARD gap follows — OA-seam-family (6) re-pin (2026-11-11): at an ILLEGAL pair\'s left-edge station Del deletes the GAP and merges (`a`+`bc` → `abc`, caret at the splice offset), superseding the old D1 first-char mirror here', () => {
    const state = forwardDelete(at(jmp(sym('a'), sym('bc')), node([0])));
    expect(j(envelopeOf(state).root)).toBe(j(sym('abc')));
    expect(state.caret).toEqual(tokc([], 1));
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

  it('OA-del-highlight (rec-mwe0xrj1-0, 2026-11-13): Del at the seam facing a fenceless structure arms the D5 highlight (was the named no-op); the confirming Del deletes it WITH content, pending null stays', () => {
    const seed = op('add', sym('x'), frac(num(1), num(2)));
    const arm = decideDelete(envOf(seed), rowc([], 1));
    expect(arm.kind).toBe('highlight');
    expect(arm.target).toEqual([1]);
    expect(arm.ops).toEqual([]); // U2: the highlight never logs
    const confirm = decideDelete(envOf(seed), rowc([], 1), { highlighted: [1] });
    expect(confirm.kind).toBe('delete-structure');
    let state = at(seed, rowc([], 1));
    state = applyOps(state, confirm.ops);
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null))); // OA-pending-null
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // the left flank station arms the same highlight; an unrelated armed target does not confirm
    expect(decideDelete(envOf(seed), { kind: 'node', path: [1], side: 'left' }).kind).toBe('highlight');
    expect(decideDelete(envOf(seed), rowc([], 1), { highlighted: [0] }).kind).toBe('highlight');
    // through the state wrapper: arm is a no-op state, confirm applies one unit
    const armed = forwardDelete(at(seed, rowc([], 1)));
    expect(j(envelopeOf(armed).root)).toBe(j(seed));
    expect(armed.log.length).toBe(0);
    const confirmed = forwardDelete(at(seed, rowc([], 1)), { highlighted: [1] });
    expect(j(envelopeOf(confirmed).root)).toBe(j(op('add', sym('x'), null)));
    expect(confirmed.log.length).toBe(1);
    legal(confirmed);
  });

  it('OA-del-highlight fires for every fenceless kind at the facing seam and the left flank (frac/pow/root/sub/op-pow)', () => {
    const mid = (structure: unknown) => op('add', sym('x'), structure as never);
    const kinds: [unknown, string][] = [
      [frac(num(1), num(2)), 'frac'],
      [{ type: 'pow', base: sym('a'), exp: num(2) }, 'pow'],
      [{ type: 'root', radicand: sym('a') }, 'root'],
      [sub('b', 'm'), 'sub'],
      [op('pow', sym('a'), num(2)), 'op-pow'],
    ];
    for (const [structure, name] of kinds) {
      const env = envOf(mid(structure));
      expect(decideDelete(env, rowc([], 1)).kind, name).toBe('highlight');
      expect(decideDelete(env, rowc([], 1), { highlighted: [1] }).kind, name).toBe('delete-structure');
      // the left flank is a node-`side` station (containers only — an op-pow row is not one)
      if (!((structure as { type: string }).type === 'op')) {
        expect(decideDelete(env, { kind: 'node', path: [1], side: 'left' }).kind, name).toBe('highlight');
      }
    }
    // fenced containers and nested rows keep the named no-op
    expect(decideDelete(envOf(mid(group(op('add', sym('a'), sym('b'))))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(mid(fn('sin', [sym('a')]))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(mid(op('multiply', sym('a'), sym('b')))), rowc([], 1)).kind).toBe('noop');
  });

  it('Del at the seam facing a fenced container / a nested row: named no-ops (unchanged — the glyph is left of the caret)', () => {
    expect(decideDelete(envOf(op('add', sym('x'), group(op('add', sym('a'), sym('b'))))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), fn('sin', [sym('a')]))), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), op('multiply', sym('a'), sym('b')))), rowc([], 1)).kind).toBe('noop');
  });

  it('OA-del-glyph (corrected reading): Del IN a non-trailing pending cell removes the dangling glyph to its right; trailing cell / row end stay no-ops', () => {
    // `|+1/2` caret in the leading pending cell → the + goes, the frac unwraps
    expect(decideDelete(envOf(op('add', null, frac(num(1), num(2)))), rowc([], 0)).kind).toBe('glyph');
    // `x+|∅|y`-class middle pending cell → the following glyph goes
    expect(decideDelete(envOf(op('add', sym('x'), null, sym('y'))), rowc([], 1)).kind).toBe('glyph');
    // `+|` all-null template, caret in the FIRST pending cell → the row dies → empty formula
    expect(decideDelete(envOf(op('add', null, null)), rowc([], 0)).kind).toBe('glyph');
    // the TRAILING pending cell (`x+|`) has nothing right of the caret → no-op; the row end too
    expect(decideDelete(envOf(op('add', sym('x'), null)), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', null, null)), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envOf(op('add', sym('x'), sym('y'))), rowc([], 2)).kind).toBe('noop');
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

// ——— OA-promote-border (2026-11-11 micro-fix session, log rec-mwcb8j6u-7) ———

describe('OA-promote-border — a flankable structure promoted to a bare root/slot position by a glyph removal lands at its border/flank station, never inside its first slot (log rec-mwcb8j6u-7)', () => {
  it('Del through a pending cell: a + 1/2, caret at a’s start, Delete ×2 — the dangling + goes, the fraction promotes to the root, the caret rests at its LEFT border station (in front of it)', () => {
    let state = forwardDelete(at(op('add', sym('a'), frac(num(1), num(2))), tokc([0], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', null, frac(num(1), num(2)))));
    expect(state.caret).toEqual(rowc([], 0));
    legal(state);
    state = forwardDelete(state);
    expect(j(envelopeOf(state).root)).toBe(j(frac(num(1), num(2))));
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'left' }); // OA-lone-root-stations: in front of the fraction, not token ['num'] @0
    legal(state);
    expect(state.log.length).toBe(2); // one undo unit per Del
  });

  it('the BS mirror: 1/2 + x, caret past x, Backspace ×2 — the trailing pending cell’s glyph goes, the fraction promotes to the root, the caret at its RIGHT border station', () => {
    let state = at(op('add', frac(num(1), num(2)), sym('x')), rowc([], 2));
    state = backspace(state); // x dies → [frac, null], caret at the pending cell
    expect(j(envelopeOf(state).root)).toBe(j(op('add', frac(num(1), num(2)), null)));
    expect(state.caret).toEqual(rowc([], 1));
    state = backspace(state); // the dangling + goes → the fraction at the root
    expect(j(envelopeOf(state).root)).toBe(j(frac(num(1), num(2))));
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'right' }); // behind the fraction
    legal(state);
  });

  it('promotion into a SLOT lands at the slot-boundary flank station', () => {
    const state = forwardDelete(at(frac(op('add', null, frac(num(3), num(4))), num(2)), rowc(['num'], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(frac(frac(num(3), num(4)), num(2))));
    expect(state.caret).toEqual({ kind: 'node', path: ['num'], side: 'left' });
    legal(state);
  });

  it('a promoted TOKEN (non-flankable) keeps the entry-station landing — unchanged', () => {
    const state = forwardDelete(at(op('add', null, sym('x')), rowc([], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(sym('x')));
    expect(state.caret).toEqual(tokc([], 0));
    legal(state);
  });
});
