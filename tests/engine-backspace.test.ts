// Backspace under the ruled contract, D1–D9 (rework session 3; supersedes the
// falsified DOM-arc session-3 model — every re-pin cites its rule from
// docs/context/interaction.md). Pins are byte-exact on tree + caret; one
// Backspace key = at most one op = one log entry (U2), and every intermediate
// state is fromJSON-legal with a resolving caret.

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';
import type { NodeJson } from '../src/ast/json.js';

import {
  applyOps,
  backspace,
  caretResolves,
  decideBackspace,
  envelopeOf,
  EngineError,
  initSession,
  redo,
  typeToken,
  undo,
  type Caret,
  type EditingState,
} from '../src/engine/index.js';

const num = (value: number, dot?: true) => ({ type: 'num', value, ...(dot ? { dot: true } : {}) });
const sym = (name: string) => ({ type: 'sym', name });
const sub = (base: string, subscript: string) => ({ type: 'sub', base, sub: subscript });
const unitNode = (value: unknown, u: string) => ({ type: 'unit', value, unit: u });
const fence = () => ({ type: 'fence', side: 'close' });
const op = (name: string, ...args: (unknown | null)[]) => ({ type: 'op', op: name, args });
const fn = (name: string, args: (unknown | null)[], close = true) =>
  ({ type: 'fn', name, args, ...(close ? {} : { close: false }) });
const group = (child: unknown, close = true) =>
  ({ type: 'group', parens: 'always', child, ...(close ? {} : { close: false }) });
const frac = (n: unknown, d: unknown) => ({ type: 'frac', num: n, den: d });
const powNode = (b: unknown, e: unknown) => ({ type: 'pow', base: b, exp: e });
const mrootNode = (radicand: unknown, index: unknown) => ({ type: 'root', radicand, index, mroot: true });
const jmp = (...args: (unknown | null)[]) => ({ type: 'op', op: 'multiply', args, implicit: true });

const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const slot = (path: readonly (number | string)[], s: string): Caret => ({ kind: 'slot', path, slot: s as never });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const tokc = (path: readonly (number | string)[], index: number, label?: 'base' | 'sub'): Caret =>
  label === undefined ? { kind: 'token', path, index } : { kind: 'token', path, index, label };

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
const envOf = (seed: unknown) => envelopeOf(initSession(wrap(seed)));

// ——— D1 (S-063, S-065 A, S-069): char-wise in tokens ———

describe('D1 — char-wise in tokens (S-063/S-065 A/S-069; the pre-rework number ruling now applies to ALL text-like tokens)', () => {
  it('in-token digit peel: the digit before the offset goes, the resulting offset stands', () => {
    let state = backspace(at(num(123), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(num(13)));
    expect(state.caret).toEqual(tokc([], 1)); // `1|3` — D1: the caret at the resulting offset (re-pin: the falsified model preserved the offset)
    legal(state);
    state = backspace(at(num(123), tokc([], 3)));
    expect(j(envelopeOf(state).root)).toBe(j(num(12)));
    expect(state.caret).toEqual(tokc([], 2)); // clamped to the shortened text
    legal(state);
  });

  it("symbols delete LETTER-wise (S-065 A: never delete the whole variable on backspace)", () => {
    let state = backspace(at(sym('abc'), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(sym('ac')));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
    state = backspace(at(sym('abc'), node([]))); // the node caret on a leaf = the right edge
    expect(j(envelopeOf(state).root)).toBe(j(sym('ab')));
    expect(state.caret).toEqual(node([]));
    legal(state);
  });

  it('unit labels are granular (S-104): 50mm| + BS → 50m| — a still-known run stays attached', () => {
    const state = backspace(at(unitNode(num(50), 'mm'), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(unitNode(num(50), 'm')));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
  });

  it('a shortened label that is no longer a unit reverts to the [num, sym] pair (the 2b-2 re-validation fires on deletion)', () => {
    const state = backspace(at(unitNode(num(50), 'Pa'), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(num(50), sym('P'))));
    expect(state.caret).toEqual(tokc([1], 1)); // the caret inside the reverted run
    legal(state);
  });

  it('an emptied label kills the unit shape — the value promotes bare (the owner\'s B-08 live reading; D1 + the 2b-2 reversion with an empty run)', () => {
    // `50m|` + BS: the label run empties → the num survives alone, the
    // caret at the splice side facing the dead label — deletion then
    // continues into the value digits
    let state = backspace(at(unitNode(num(50), 'm'), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(num(50)));
    expect(state.caret).toEqual(tokc([], 2));
    legal(state);
    // the full B-08 chain: `50mm` + BS ×3 → `m` → (the revert) `50` → `5`
    state = backspace(backspace(backspace(at(unitNode(num(50), 'mm'), tokc([], 2)))));
    expect(j(envelopeOf(state).root)).toBe(j(num(5)));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
  });

  it('sub labels delete char-wise (T9); a shape-breaking base shrink is a silent no-op', () => {
    const state = backspace(at(sub('x', 'abc'), tokc([], 3, 'sub')));
    expect(j(envelopeOf(state).root)).toBe(j(sub('x', 'ab')));
    expect(state.caret).toEqual(tokc([], 2, 'sub'));
    legal(state);
    // the base's first letter keeps its identifier shape; deleting it whole empties it
    let state2 = backspace(at(sub('abx', 'max'), tokc([], 1, 'base')));
    expect(j(envelopeOf(state2).root)).toBe(j(sub('bx', 'max')));
    legal(state2);
    // 'a|1' of a base whose name would break identifier shape mid-label — the
    // shape rule allows any interior shrink; the start-edge case is covered by
    // the '1' prefixes being unreachable (digit-glue keeps the leading letter)
    state2 = backspace(at(sub('ab', 'x'), tokc([], 2, 'base')));
    expect(j(envelopeOf(state2).root)).toBe(j(sub('a', 'x')));
    legal(state2);
  });

  it('an emptied token removes the NODE, caret in the freed position: a row cell becomes the PENDING NULL — the glyph survives dangling', () => {
    // `x+y|` BS: y's only letter goes → `x+` (D1: the freed row position is the pending null)
    const state = backspace(at(op('add', sym('x'), sym('y')), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1)); // the caret sits in the freed pending cell
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it('at a fixed slot the □, at the root the empty formula; the middle cell of a longer row empties to its own pending null (the a+b++c class state)', () => {
    let state = backspace(at(frac(num(5), num(3)), node(['num'])));
    expect(j(envelopeOf(state).root)).toBe(j(frac(null, num(3))));
    expect(state.caret).toEqual(slot([], 'num'));
    legal(state);
    state = backspace(at(num(5), node([])));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
    state = backspace(at(op('add', sym('a'), sym('b'), sym('c')), node([1])));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('a'), null, sym('c'))));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('dot interplay (T4/OA-dot-eval): BS deleting the trailing dot clears the field; the 0. auto-prefix loses it equally; deleting the 0 kills the in-progress number', () => {
    let state = backspace(at(num(5, true), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(num(5)));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
    state = backspace(at(num(0, true), tokc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(num(0)));
    legal(state);
    // '.' alone is unrepresentable — the node dies (the pinned judgment)
    state = backspace(at(num(0, true), tokc([], 1)));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
  });
});

// ——— D2 (S-064, S-066 A, S-077): gaps ———

describe('D2 — backspace at gaps (S-064/S-066 A/S-077)', () => {
  it('the shared station consumes the left-adjacent token: its LAST character (S-064)', () => {
    // `a+bc|` at the end seam: c goes, the seam survives the replace
    let state = backspace(at(op('add', sym('a'), sym('bc')), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('a'), sym('b'))));
    expect(state.caret).toEqual(rowc([], 2));
    legal(state);
    // OA-seam-family (6) re-pin (2026-11-11): the glyph-free juxtaposition
    // seam of an ILLEGAL pair (sym-sym refuses) — BS at the right-edge station
    // deletes the GAP and merges the sides (letter glue `ab`+`c` → `abc`,
    // caret at the splice offset) — supersedes the D2 left-consume here.
    state = backspace(at(jmp(sym('ab'), sym('c')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(sym('abc')));
    expect(state.caret).toEqual(tokc([], 2)); // the boundary inside the merged token
    expect(state.log.length).toBe(1); // one op = one undo unit
    legal(state);
  });

  it('the BINDING glyph at the station deletes — the operands bond into an implicit pair (S-077 + the owner\'s B-15 live ruling)', () => {
    // `ab+|c` → ab·c: the glyph dies (never the right cell), the two-cell row
    // unwraps to the pair at its position
    let state = backspace(at(op('add', sym('ab'), sym('c')), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('ab'), sym('c'))));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcmhuyq-2, supersedes B-33 (2)'s
    // left-edge landing): the caret rests at the gap's RIGHT edge — c's offset 0
    expect(state.caret).toEqual(tokc([1], 0));
    expect(state.log.length).toBe(1);
    legal(state);
    // `x + |1/2`: NO highlight from the before-side — the plus dies and the
    // operands juxtapose (`x 1/2`); the caret lands at the gap's RIGHT edge —
    // in front of the fraction, never into the numerator
    state = backspace(at(op('add', sym('x'), frac(num(1), num(2))), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('x'), frac(num(1), num(2)))));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcmhuyq-2, supersedes B-33 (2))
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // the gap before a function deletes the `+` too — never the fn (S-077)
    state = backspace(at(op('add', sym('x'), fn('sin', [sym('a')])), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('x'), fn('sin', [sym('a')]))));
    legal(state);
    // a longer row keeps its cells: a+b+|c → a + b·c (the pair nests in place)
    state = backspace(at(op('add', sym('a'), sym('b'), sym('c')), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('a'), jmp(sym('b'), sym('c')))));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcmhuyq-2, supersedes B-33 (2)):
    // the freed spot lands at the nested pair's RIGHT edge — c's offset 0
    expect(state.caret).toEqual(tokc([1, 1], 0));
    legal(state);
    // the Ctrl variant keeps the glyph-delete (a one-character glyph has no run)
    state = backspace(at(op('add', sym('x'), frac(num(1), num(2))), rowc([], 1)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('x'), frac(num(1), num(2)))));
    legal(state);
  });

  it('S-066 A byte pin: −x+| → −x| — the dangling trailing glyph deletes, one op', () => {
    const state = backspace(at(op('subtract', null, op('add', sym('x'), null)), rowc([1], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('subtract', null, sym('x'))));
    expect(state.caret).toEqual(rowc([], 2));
    expect(state.log.length).toBe(1);
    legal(state);
    const undone = undo(state);
    expect(j(envelopeOf(undone).root)).toBe(j(op('subtract', null, op('add', sym('x'), null))));
    expect(undone.caret).toEqual(rowc([1], 1));
    legal(undone);
  });

  it('the dangling-glyph family: the pending cell splices; a one-cell remainder unwraps into its cell; the empty template dies', () => {
    let state = backspace(at(op('add', sym('x'), null), rowc([], 1))); // the trailing-pending cell
    expect(j(envelopeOf(state).root)).toBe(j(sym('x')));
    expect(state.caret).toEqual(tokc([], 1)); // `x|` — the promoted cell's right edge
    legal(state);
    state = backspace(at(op('add', null, sym('a')), rowc([], 1))); // `+|a` (S-003's leading flow)
    expect(j(envelopeOf(state).root)).toBe(j(sym('a')));
    expect(state.caret).toEqual(tokc([], 1));
    legal(state);
    state = backspace(at(op('add', null, null), rowc([], 1))); // the fresh template: glyph + both cells go
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
    // the doubled interior: 2−−|3 → 2−|3 ([2,∅,3] → [2,3], the seam between)
    state = backspace(at(op('subtract', num(2), null, num(3)), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('subtract', num(2), num(3))));
    // 4b-1 re-pin (OA-visual-trumps): the freed zone collapses onto the
    // following cell's left entry (its offset 0) — the raw seam painted
    // at the same spot.
    expect(state.caret).toEqual(tokc([1], 0));
    legal(state);
    // and at the void between the −s: the caret's own pending cell splices
    state = backspace(at(op('subtract', num(2), null, num(3)), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(op('subtract', num(2), num(3))));
    expect(state.caret).toEqual(tokc([1], 0));
    legal(state);
    // a longer row keeps its cells: [a,b,∅] → [a,b]
    state = backspace(at(op('add', sym('a'), sym('b'), null), rowc([], 3)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('a'), sym('b'))));
    // 4b-1 re-pin (OA-visual-trumps): the freed trailing zone collapses
    // onto the last cell's in-token end.
    expect(state.caret).toEqual(tokc([1], 1));
    legal(state);
  });

  it('a nested dangling glyph deletes through the edge (a−×b| → a−b| — the inner row unwraps in ONE op)', () => {
    const state = backspace(at(op('subtract', sym('a'), op('multiply', sym('b'), null)), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('subtract', sym('a'), sym('b'))));
    expect(state.caret).toEqual(rowc([], 2));
    legal(state);
  });

  it('a token caret at offset 0 IS the shared gap before its cell (D2 through the left edge — the binding glyph bonds)', () => {
    const state = backspace(at(op('add', sym('ab'), sym('c')), tokc([1], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(sym('ab'), sym('c'))));
    legal(state);
  });

  it('BS at the gap before a function is the ordinary gap rule (S-077): the leading dangling + deletes, never the fn', () => {
    const state = backspace(at(op('add', null, fn('sin', [sym('a')])), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('a')])));
    // re-pinned 2026-11-11 (OA-promote-border, the B-33-family landing ruling):
    // the promoted fn lands at its RIGHT border station (behind it) — the old
    // 4a content-end bench (token [0] @1) dived inside the function
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'right' });
    legal(state);
  });
});

// ——— D3 (S-067, S-068, S-071): Ctrl+BS split semantics ———

describe('D3 — Ctrl+Backspace (S-067/S-068/S-071)', () => {
  it('in-token: everything left of the caret goes (text[i..) survives, caret offset 0)', () => {
    let state = backspace(at(sym('abcd'), tokc([], 2)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(sym('cd')));
    expect(state.caret).toEqual(tokc([], 0));
    legal(state);
    state = backspace(at(num(125), tokc([], 2)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(num(5)));
    expect(state.caret).toEqual(tokc([], 0));
    legal(state);
  });

  it("the whole token only at offset = length — the token right edge / the node caret on a leaf", () => {
    let state = backspace(at(num(123), tokc([], 3)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
    state = backspace(at(num(123), node([])), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe('null');
    legal(state);
    // an unrepresentable in-progress remainder (the lone '.') dies whole
    state = backspace(at(num(5, true), tokc([], 1)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe('null');
    legal(state);
  });

  it('at gaps the left-adjacent TEXT token dies whole — the freed position the pending null (the word delete)', () => {
    const state = backspace(at(op('add', sym('x'), sym('abc')), rowc([], 2)), { ctrl: true });
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('Ctrl+BS at the AFTER-station keeps the D5 two-step (the highlight decision; a structure\'s instant ctrl-delete is unruled)', () => {
    const d = decideBackspace(envOf(op('add', sym('x'), frac(num(1), num(2)))), rowc([], 2), { ctrl: true });
    expect(d.kind).toBe('highlight');
    expect(d.ops.length).toBe(0);
    expect(d.target).toEqual([1]);
  });
});

// ——— D4 (S-078): silent no-ops ———

describe('D4 — silent no-ops (S-078 and the region-start family)', () => {
  it('BS on the empty formula: nothing applied, nothing logged (S-078)', () => {
    let state = at(null, { kind: 'empty' });
    const after = backspace(state);
    expect(after).toBe(state);
    expect(state.log.length).toBe(0);
  });

  it("region starts and invisible gaps: a token row seam 0, the leading pending cell, a root token left edge, a slot content start, cross-label sub stations", () => {
    const cases: [unknown, Caret][] = [
      [op('add', sym('a'), sym('b')), rowc([], 0)],
      [op('add', null, sym('a')), rowc([], 0)], // the caret stands before the leading glyph
      [sym('abc'), tokc([], 0)],
      [frac(sym('a'), num(2)), tokc(['num'], 0)],
      [sub('a', 'x'), tokc([], 0, 'sub')], // the script's start with content: cross-label (unruled → no-op)
      [journalHelper(), tokc([], 0)],
    ];
    function journalHelper(): unknown {
      return sym('seed-unused');
    }
    for (const [seed, caret] of cases) {
      const before = at(seed, caret);
      const after = backspace(before);
      expect(after).toBe(before);
      expect(j(envelopeOf(after))).toBe(j(envelopeOf(before)));
    }
  });

  it('decideBackspace throws caret-invalid on an unresolvable caret', () => {
    expect(() => decideBackspace(envOf(num(1)), tokc([], 9))).toThrowError(EngineError);
    expect(() => decideBackspace(envOf(num(1)), tokc([], 9))).toThrowError(/caret-invalid|does not resolve/);
  });
});

// ——— D5 (S-044 note, S-072, S-109): highlight-then-delete ———

describe('D5 — highlight-then-delete, fenceless 2D only, outside stations only (S-072/S-109)', () => {
  const F = op('add', sym('x'), frac(num(1), num(2)));
  const P = op('add', sym('x'), powNode(sym('a'), num(2)));

  it('BS at the station AFTER the structure returns the highlight decision: no op, NOTHING LOGGED (U2)', () => {
    const d = decideBackspace(envOf(F), rowc([], 2));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]);
    expect(d.ops.length).toBe(0);
    expect(d.caret).toEqual(rowc([], 2));
    const before = at(F, rowc([], 2));
    const state = backspace(before);
    expect(state).toBe(before); // nothing applied, nothing logged — the same state object
    expect(state.log.length).toBe(0);
  });

  it('BS at the gap BEFORE the structure is NO highlight — the ordinary glyph rule (the owner\'s B-15 live ruling); the node caret on a complete structure reads as the after-station', () => {
    const d = decideBackspace(envOf(op('add', sym('x'), frac(num(1), num(2)))), rowc([], 1));
    expect(d.kind).toBe('glyph');
    expect(d.ops.length).toBe(1);
    const d0 = decideBackspace(envOf(op('add', frac(num(1), num(2)), sym('x'))), rowc([], 0));
    expect(d0.kind).toBe('noop'); // nothing stands left — D4's region start
    // the node caret on a complete root structure reads as the after-station
    const d2 = decideBackspace(envOf(frac(num(1), num(2))), node([]));
    expect(d2.kind).toBe('highlight');
    expect(d2.target).toEqual([]);
  });

  it('S-044 anchor: a^2| highlights the WHOLE power — never the exponent alone', () => {
    const d = decideBackspace(envOf(P), rowc([], 2));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]);
  });

  it('the confirm deletes the structure WITH its content, caret at the freed position; undo restores the whole structure (U2)', () => {
    const d = decideBackspace(envOf(F), rowc([], 2), { highlighted: [1] });
    expect(d.kind).toBe('delete-structure');
    expect(d.ops.length).toBe(1);
    const state = backspace(at(F, rowc([], 2)), { highlighted: [1] });
    // B-14: only the fraction dies — the plus keeps dangling over the freed
    // pending cell (`x + `)
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    expect(state.caret).toEqual(rowc([], 1)); // the freed cell
    expect(state.log.length).toBe(1);
    legal(state);
    const undone = undo(state);
    expect(j(envelopeOf(undone).root)).toBe(j(F));
    expect(undone.caret).toEqual(rowc([], 2));
    legal(undone);
    const redone = redo(undone);
    expect(j(envelopeOf(redone).root)).toBe(j(op('add', sym('x'), null)));
    expect(redone.caret).toEqual(rowc([], 1));
  });

  it('an armed target at a different station does not confirm — the fresh decision takes over', () => {
    const d = decideBackspace(envOf(P), rowc([], 2), { highlighted: [7] });
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]);
  });

  it('fenced containers do NOT highlight — the D7/D8 close-fence chain takes them (S-075/S-076)', () => {
    expect(decideBackspace(envOf(op('add', sym('x'), group(op('add', sym('a'), sym('b'))))), rowc([], 2)).kind).toBe('close-fence');
    expect(decideBackspace(envOf(op('add', sym('x'), fn('sin', [sym('a')]))), rowc([], 2)).kind).toBe('close-fence');
  });

  it('the highlight never fires from INSIDE a slot (S-109): in-slot BS is char-wise, at the □ it is D6', () => {
    const inner = decideBackspace(envOf(frac(op('add', sym('a'), sym('bc')), num(2))), rowc(['num'], 2));
    expect(inner.kind).toBe('char'); // c goes — char-wise inside the slot, never the highlight
    const atVoid = decideBackspace(envOf(frac(null, num(2))), slot([], 'num'));
    expect(atVoid.kind).toBe('unwrap');
  });

  it('the op-pow projection shape takes D5 too (a flat ≤2-arg pow row renders as a 2D power)', () => {
    const d = decideBackspace(envOf(op('add', sym('x'), op('pow', sym('a'), num(2)))), rowc([], 2));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]);
  });
});

// ——— D6 (S-073, S-074, S-100–S-102, S-109): the □-unwrap and PROMOTE ———

describe('D6 — BS at a □ unwraps and promotes (S-073/S-074/S-100–S-102/S-109)', () => {
  it('the ruled byte pin x + frac(□,2) → BS → x + |2 (one op; undo restores tree AND caret byte-exactly)', () => {
    const state = backspace(at(op('add', sym('x'), frac(null, num(2))), slot([1], 'num')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), num(2))));
    expect(state.caret).toEqual(rowc([], 1)); // `x + |2` — the splice point
    expect(state.log.length).toBe(1);
    legal(state);
    const undone = undo(state);
    expect(j(envelopeOf(undone).root)).toBe(j(op('add', sym('x'), frac(null, num(2)))));
    expect(undone.caret).toEqual(slot([1], 'num'));
    legal(undone);
    const redone = redo(undone);
    expect(j(envelopeOf(redone).root)).toBe(j(op('add', sym('x'), num(2))));
    expect(redone.caret).toEqual(rowc([], 1));
  });

  it('S-101 mirror: the denominator-□ promotes the NUMERATOR inline, caret at the promoted content', () => {
    const state = backspace(at(op('add', sym('x'), frac(num(2), null)), slot([1], 'den')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), num(2))));
    expect(state.caret).toEqual(rowc([], 2)); // `x + 2|`
    legal(state);
  });

  it('S-074 byte pin: a^□ → BS → a|', () => {
    const state = backspace(at(powNode(sym('a'), null), slot([], 'exp')));
    expect(j(envelopeOf(state).root)).toBe(j(sym('a')));
    expect(state.caret).toEqual(tokc([], 1)); // `a|` — after the promoted base
    legal(state);
  });

  it("the base-□ mirror promotes the exponent (the uniform both-halves reading, caret at the deleted-slot side)", () => {
    const state = backspace(at(powNode(null, num(2)), slot([], 'base')));
    expect(j(envelopeOf(state).root)).toBe(j(num(2)));
    expect(state.caret).toEqual(tokc([], 0)); // `|2`
    legal(state);
  });

  it('S-101: the root — the index-□ promotes the RADICAND, caret in FRONT of it (x + ₙ√a → x + |a — the owner\'s B-18 ruling: the index is a LEFT slot)', () => {
    const state = backspace(at(op('add', sym('x'), mrootNode(sym('a'), null)), slot([1], 'index')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), sym('a'))));
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('the owner\'s B-18 rulings — three positions inside/at a root: the radicand start strips the glyph; behind the content is char-wise→□→death; behind the whole root highlights', () => {
    // the FIRST position inside the root — in front of the radicand content:
    // the radical glyph deletes, the radicand promotes, caret stays in front
    const strip = backspace(
      at(op('add', sym('x'), { type: 'root', radicand: sym('a') } as NodeJson), tokc([1, 'radicand'], 0)),
    );
    expect(j(envelopeOf(strip).root)).toBe(j(op('add', sym('x'), sym('a'))));
    expect(strip.caret).toEqual(tokc([1], 0)); // `x + |a`
    expect(strip.log.length).toBe(1);
    legal(strip);
    // a row radicand strips through its seam 0 the same way; the mroot's
    // index label dies with the glyph (a modifier channel)
    const stripRow = backspace(
      at({ type: 'root', radicand: op('add', sym('a'), sym('b')), mroot: true } as NodeJson, rowc(['radicand'], 0)),
    );
    expect(j(envelopeOf(stripRow).root)).toBe(j(op('add', sym('a'), sym('b'))));
    expect(stripRow.caret).toEqual(rowc([], 0));
    legal(stripRow);
    // position 1 — directly behind the radicand content: char-wise to the □,
    // then the whole root dies (both slots empty)
    let p1 = at({ type: 'root', radicand: sym('a') } as NodeJson, node(['radicand']));
    p1 = backspace(p1);
    expect(j(envelopeOf(p1).root)).toBe(j({ type: 'root', radicand: null } as NodeJson));
    expect(p1.caret).toEqual(slot([], 'radicand'));
    legal(p1);
    p1 = backspace(p1);
    expect(j(envelopeOf(p1).root)).toBe('null');
    expect(p1.caret).toEqual({ kind: 'empty' });
    legal(p1);
    // position 2 — directly behind the whole root: the D5 highlight
    const d = decideBackspace(envOf(op('add', sym('x'), { type: 'root', radicand: sym('a') } as NodeJson)), rowc([], 2));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]);
  });

  it('S-102: the subscript-□ dies with the base staying as a symbol; a baseless sub dies with nothing promoted; both-empty dies outright', () => {
    let state = backspace(at(op('add', sym('x'), sub('a', '')), tokc([1], 0, 'sub')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), sym('a'))));
    expect(state.caret).toEqual(rowc([], 2)); // `x + a|`
    legal(state);
    state = backspace(at(sub('a', ''), tokc([], 0, 'sub')));
    expect(j(envelopeOf(state).root)).toBe(j(sym('a')));
    expect(state.caret).toEqual(tokc([], 1)); // `a|`
    legal(state);
    state = backspace(at(sub('', ''), tokc([], 0, 'base')));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    legal(state);
    // a baseless sub with script content: no promotable content (the script is
    // a modifier channel) — the structure dies
    state = backspace(at(sub('', 'max'), tokc([], 0, 'base')));
    expect(j(envelopeOf(state).root)).toBe('null');
    legal(state);
  });

  it('S-109/S-100: the unwrap works at depth — frac(frac(□,b),2) → frac(b,2), the caret inside the promoted numerator', () => {
    const state = backspace(at(frac(frac(null, sym('b')), num(2)), slot(['num'], 'num')));
    expect(j(envelopeOf(state).root)).toBe(j(frac(sym('b'), num(2))));
    expect(state.caret).toEqual(tokc(['num'], 0)); // `|b` — the deleted slot faced the left
    legal(state);
  });

  it('both slots empty → the structure dies outright, nothing promoted (S-073)', () => {
    for (const c of [slot([], 'num'), slot([], 'den')]) {
      const state = backspace(at(frac(null, null), c));
      expect(j(envelopeOf(state).root)).toBe('null');
      expect(state.caret).toEqual({ kind: 'empty' });
      expect(state.log.length).toBe(1);
      legal(state);
    }
  });

  it("the owner's B-18 follow-up: outright deaths at an ARGS CELL leave the PENDING NULL — only the dying node goes, the + keeps dangling (x + √□ → x + |)", () => {
    const deaths: { tree: unknown; caret: Caret }[] = [
      // the flagged state itself: the empty radicand in an args row
      { tree: op('add', sym('x'), { type: 'root', radicand: null } as NodeJson), caret: slot([1], 'radicand') },
      // the same death class: the both-empty frac, the baseless sub, the valueless unit
      { tree: op('add', sym('x'), frac(null, null)), caret: slot([1], 'num') },
      { tree: op('add', sym('x'), sub('', '')), caret: tokc([1], 0, 'base') },
      { tree: op('add', sym('x'), { type: 'unit', value: null, unit: 'm' } as NodeJson), caret: tokc([1], 1) },
    ];
    for (const { tree, caret } of deaths) {
      const state = backspace(at(tree, caret));
      expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)), `death case ${j(caret)}`);
      expect(state.caret).toEqual(rowc([], 1));
      expect(state.log.length).toBe(1);
      legal(state);
      const undone = undo(state);
      expect(j(envelopeOf(undone).root)).toBe(j(tree));
      expect(undone.caret).toEqual(caret);
      legal(undone);
    }
  });

  it('the D5/D6 asymmetry is INTENDED (S-102: outside deletes with content, inside unwraps and keeps the sibling)', () => {
    const outside = backspace(at(op('add', sym('x'), frac(num(1), num(2))), rowc([], 2)), { highlighted: [1] });
    expect(j(envelopeOf(outside).root)).toBe(j(op('add', sym('x'), null)));
    const inside = backspace(at(op('add', sym('x'), frac(num(1), null)), slot([1], 'den')));
    expect(j(envelopeOf(inside).root)).toBe(j(op('add', sym('x'), num(1))));
    legal(inside);
  });
});

// ——— D7 (S-023 A, S-075, S-077): functions ———

describe('D7 — the function chain + the head swap (S-075/S-077, the S-023 A anchor)', () => {
  const SIN_AB = fn('sin', [op('add', sym('a'), sym('b'))]);

  it('the movable close paren deletes first (C4): close → false, the caret continues at the content right edge', () => {
    let state = backspace(at(SIN_AB, node([])));
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [op('add', sym('a'), sym('b'))], false)));
    // 4a re-pin (OA-visual-trumps): the content right edge is the in-token end
    expect(state.caret).toEqual({ kind: 'token', path: [0, 1], index: 1 }); // the content tail inside the fn: sin(a+b|
    expect(state.log.length).toBe(1);
    legal(state);
    // a group takes the same chain (D8): caret at its child row's tail
    state = backspace(at(group(op('add', sym('a'), sym('b'))), node([])));
    expect(j(envelopeOf(state).root)).toBe(j(group(op('add', sym('a'), sym('b')), false)));
    // 4a re-pin (OA-visual-trumps): the content right edge is the in-token end
    expect(state.caret).toEqual({ kind: 'token', path: ['child', 1], index: 1 });
    legal(state);
  });

  it('the open-ended chain runs char-wise inward: the emptied operand keeps the glyph dangling (sin(a+ in one op)', () => {
    const state = backspace(at(op('add', sym('x'), fn('sin', [op('add', sym('a'), sym('b'))], false)), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), fn('sin', [op('add', sym('a'), null)], false))));
    expect(state.caret).toEqual(rowc([1, 0], 1)); // the freed pending cell inside
    legal(state);
  });

  it('S-077 head-swap byte pin: sin(a+b) → BS at the argument start → a+b) — content and closing paren survive', () => {
    const state = backspace(at(SIN_AB, rowc([], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(op('add', sym('a'), sym('b')), fence())));
    expect(state.caret).toEqual(rowc([], 0)); // `|a+b)` — the head's former position
    expect(state.log.length).toBe(1);
    legal(state);
    // at close:false only the content survives
    const bare = backspace(at(fn('sin', [sym('a')], false), rowc([], 0)));
    expect(j(envelopeOf(bare).root)).toBe(j(sym('a')));
    legal(bare);
  });

  it('a head with an emptied argument meets both rules at one station — the □ reading wins (S-023 A: "the empty-arg chain is explicitly unchanged"); the head swap needs content to survive', () => {
    // the fresh sin(|□): the caret sits IN the empty argument
    let state = backspace(at(fn('sin', [null]), rowc([], 0)));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(1);
    legal(state);
    // the multi-arg convergence RE-RULED (the owner's B-23 live ruling): no
    // placeholder beyond the first argument — the emptied second argument
    // collapses WITH its comma, the caret at the removed cell's seam
    state = backspace(at(fn('sin', [sym('x'), null]), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('x')])));
    // 4b-1 re-pin (OA-visual-trumps): sin(x| collapses onto x's in-token
    // end — the fn row-end seam painted at the same spot (the closed fence
    // aside, the seat's behavior is char-line identical).
    expect(state.caret).toEqual(tokc([0], 1));
    expect(state.log.length).toBe(1);
    legal(state);
    // and the freed spot inside a parent row is the parent seam
    state = backspace(at(op('add', sym('x'), fn('sin', [null])), rowc([1], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null))); // the + dangles (B-14)
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
  });

  it('an empty argument LEFT of the seam splices away with its comma (the D2 dangling analog in fn rows)', () => {
    const state = backspace(at(fn('sin', [null, sym('y')]), rowc([], 1)));
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('y')])));
    // 4b-1 re-pin (OA-visual-trumps): the freed comma zone collapses onto
    // the following argument's left entry.
    expect(state.caret).toEqual(tokc([0], 0));
    legal(state);
  });

  it("the owner's B-23 chain, key by key: sin(x,y) → sin(x,|) → sin(x|) → sin(|□) → the fn dies — one log entry per key, byte-exact undo/redo", () => {
    let state = at(fn('sin', [sym('x'), sym('y')]), rowc([], 2));
    state = backspace(state); // y: its only letter — the freed cell is the seat
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('x'), null])));
    expect(state.caret).toEqual(rowc([], 1)); // sin(x,| — no placeholder renders
    state = backspace(state); // the emptied second argument collapses WITH its comma
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('x')])));
    // 4b-1 re-pin (OA-visual-trumps): sin(x| collapses onto x's in-token end.
    expect(state.caret).toEqual(tokc([0], 1));
    state = backspace(state); // x: its only letter
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [null])));
    expect(state.caret).toEqual(rowc([], 0)); // sin(|□)
    state = backspace(state); // the FIRST argument's □: the whole fn dies
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      state = undo(state);
      legal(state);
    }
    expect(j(envelopeOf(state).root)).toBe(j(fn('sin', [sym('x'), sym('y')])));
    expect(state.caret).toEqual(rowc([], 2));
    expect(state.log.length).toBe(0);
    for (let i = 0; i < 4; i++) state = redo(state);
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
  });

  it('a mid-row empty argument collapses with its comma from either of its seats (B-23)', () => {
    const inside = backspace(at(fn('sin', [sym('x'), null, sym('z')]), rowc([], 1)));
    expect(j(envelopeOf(inside).root)).toBe(j(fn('sin', [sym('x'), sym('z')])));
    // 4b-1 re-pin (OA-visual-trumps): sin(x,|z collapses onto z's left entry.
    expect(inside.caret).toEqual(tokc([1], 0)); // sin(x,|z
    legal(inside);
    const behind = backspace(at(fn('sin', [sym('x'), null, sym('z')]), rowc([], 2)));
    expect(j(envelopeOf(behind).root)).toBe(j(fn('sin', [sym('x'), sym('z')])));
    expect(behind.caret).toEqual(tokc([1], 0)); // sin(x,|z
    legal(behind);
  });

  it('BS from BEHIND an open-ended fn whose trailing argument emptied collapses it too (B-23 from the tail side)', () => {
    const state = backspace(at(op('add', sym('x'), fn('sin', [sym('a'), null], false)), node([1])));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), fn('sin', [sym('a')], false))));
    // 4b-1 re-pin (OA-visual-trumps): the freed zone collapses onto the
    // last remaining argument's right end.
    expect(state.caret).toEqual(tokc([1, 0], 1)); // x + sin(a|
    expect(state.log.length).toBe(1);
    legal(state);
  });
});

// ——— D8 (S-076) + D9 (S-079 A, S-103): groups ———

describe('D8/D9 — the group chain + whole-group death at the □ (S-076/S-079 A/S-103)', () => {
  const G_AB = group(op('add', sym('a'), sym('b')));

  it('S-076: letter-wise through the content, the movable close paren first — no highlight, no confirmation', () => {
    const state = backspace(at(G_AB, node([])));
    expect(j(envelopeOf(state).root)).toBe(j(group(op('add', sym('a'), sym('b')), false)));
    expect(state.log.length).toBe(1);
    legal(state);
  });

  it("the open-ended group content deletes char-wise with its glyphs INCLUDED: (a+b| BS → (a+ (the freed pending cell)", () => {
    const state = backspace(at(op('add', sym('x'), group(op('add', sym('a'), sym('b')), false)), rowc([], 2)));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), group(op('add', sym('a'), null), false))));
    expect(state.caret).toEqual(rowc([1, 'child'], 1));
    legal(state);
  });

  it("the OPEN fence deletes at the content start (S-076 bracket: letter-by-letter incl. the opening parens): (|a+b) → |a+b)", () => {
    const state = backspace(at(G_AB, rowc(['child'], 0)));
    expect(j(envelopeOf(state).root)).toBe(j(jmp(op('add', sym('a'), sym('b')), fence())));
    expect(state.caret).toEqual(rowc([], 0));
    expect(state.log.length).toBe(1);
    legal(state);
    // a single-token child expresses the same station through its offset 0
    const tok = backspace(at(group(sym('a')), tokc(['child'], 0)));
    expect(j(envelopeOf(tok).root)).toBe(j(jmp(sym('a'), fence())));
    legal(tok);
    // at close:false the content promotes alone
    const bare = backspace(at(group(op('add', sym('a'), sym('b')), false), rowc(['child'], 0)));
    expect(j(envelopeOf(bare).root)).toBe(j(op('add', sym('a'), sym('b'))));
    legal(bare);
  });

  it("S-103/D9 byte pin: (| empty box) — BS at the group placeholder deletes the ENTIRE group, both fences in one stroke", () => {
    let state = backspace(at(group(null), slot([], 'child')));
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(1);
    legal(state);
    // in a parent row: the freed seam
    state = backspace(at(op('add', sym('x'), group(null)), slot([1], 'child')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null))); // the + dangles (B-26)
    expect(state.caret).toEqual(rowc([], 1));
    legal(state);
    // close:false + the empty child: the remaining open fence goes too
    state = backspace(at(op('add', sym('x'), group(null, false)), slot([1], 'child')));
    expect(j(envelopeOf(state).root)).toBe(j(op('add', sym('x'), null)));
    legal(state);
  });

  it("the whole D8 chain pressed key by key: the close, b, the plus, a, the □ whole death — one log entry per key, byte-exact undo/redo", () => {
    let state = at(G_AB, node([]));
    state = backspace(state); // the )
    expect(j(envelopeOf(state).root)).toBe(j(group(op('add', sym('a'), sym('b')), false)));
    state = backspace(state); // b: its only letter — (a+
    expect(j(envelopeOf(state).root)).toBe(j(group(op('add', sym('a'), null), false)));
    state = backspace(state); // the dangling + splices; the child row unwraps to a
    expect(j(envelopeOf(state).root)).toBe(j(group(sym('a'), false)));
    state = backspace(state); // a's letter: the □
    expect(j(envelopeOf(state).root)).toBe(j(group(null, false)));
    state = backspace(state); // D9: the whole group dies
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      state = undo(state);
      legal(state);
    }
    expect(j(envelopeOf(state).root)).toBe(j(G_AB));
    expect(state.caret).toEqual(node([]));
    expect(state.log.length).toBe(0);
    for (let i = 0; i < 5; i++) state = redo(state);
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
  });
});

// ——— movable fence tokens + no-ruled-inner-chain containers ———

describe('movable fence tokens + container parity', () => {
  it('a dangling close-fence token deletes whole (a movable glyph token, C4)', () => {
    const state = backspace(at(jmp(sym('b'), fence()), node([1])));
    expect(j(envelopeOf(state).root)).not.toContain('fence');
    legal(state);
  });

  it('a valueless unit dies whole (no ruled inner chain)', () => {
    const state = backspace(at(unitNode(null, 'mm'), slot([], 'value')));
    expect(j(envelopeOf(state).root)).toBe('null');
    legal(state);
  });
});

// ——— U2: one key = one op = one log entry ———

describe('U2 — one key, one op, one log entry; fromJSON legality at every intermediate', () => {
  it('the compound outcomes apply exactly one op each: the D6 unwrap, the D7 head delete, the D8 open fence, the D9 whole-group death', () => {
    const matrix: [unknown, Caret][] = [
      [op('add', sym('x'), frac(null, num(2))), slot([1], 'num')],
      [fn('sin', [op('add', sym('a'), sym('b'))]), rowc([], 0)],
      [group(op('add', sym('a'), sym('b'))), rowc(['child'], 0)],
      [group(null), slot([], 'child')],
      [op('subtract', null, op('add', sym('x'), null)), rowc([1], 1)],
    ];
    for (const [seed, caret] of matrix) {
      const before = at(seed, caret);
      const state = backspace(before);
      expect(state.log.length).toBe(1);
      const undone = undo(state);
      expect(j(envelopeOf(undone).root)).toBe(j(seed));
      expect(undone.caret).toEqual(caret);
      legal(undone);
      const redone = redo(undone);
      expect(j(envelopeOf(redone).root)).toBe(j(envelopeOf(state).root));
      expect(redone.caret).toEqual(state.caret);
      legal(redone);
    }
    // the D5 highlight never logs (the AFTER-station arms it)
    const d5 = backspace(at(op('add', sym('x'), frac(num(1), num(2))), rowc([], 2)));
    expect(d5.log.length).toBe(0);
  });

  it('deletion never fires through the T8 pending path (OA-one-shot: BS discards the pending before its ordinary job — controller-side, pinned in the jsdom suite)', () => {
    // engine-level this is vacuous (the engine has no pending state); the pin
    // lives in tests/editor-backspace.test.ts.
    expect(true).toBe(true);
  });

  it('a full rundown — (a+b) at the root BS to empty — every intermediate legal, implicit-multiply subrows never flatten into explicit parents', () => {
    let state = at(group(op('add', sym('a'), sym('b'))), node([]));
    for (let i = 0; i < 6; i++) {
      state = backspace(state);
      legal(state);
    }
    expect(j(envelopeOf(state).root)).toBe('null');
    expect(state.caret).toEqual({ kind: 'empty' });
    // the open-fence intermediate carries an implicit row with a fence cell
    // (OA-mixed shape): the marker rides the subrow, nothing flattens it
    const tether = backspace(at(group(op('add', sym('a'), sym('b'))), rowc(['child'], 0)));
    expect(j(envelopeOf(tether).root)).toBe(j(jmp(op('add', sym('a'), sym('b')), fence())));
    legal(tether);
  });
});

// ——— OA-invisible-death (2026-11-11 micro-fix session, log rec-mwcb3stc-6) ———

describe('OA-invisible-death — an all-null implicit (glyph-less) row renders nothing, so it must not persist in the AST (owner ruling 2026-11-11: "nothing visible → nothing in the AST")', () => {
  it('unit→symbol reversion inside a dangling implicit pair: backspacing everything away ends at the EMPTY formula — no leftover invisible rows, caret empty, one undo unit per key', () => {
    let state = at(jmp(null, unitNode(num(50), 'mm')), tokc([1], 0));
    state = typeToken(state, { t: 'leaf', node: sym('x') }); // the letter at the unit seam reverts the unit to the [50, xmm] pair
    expect(j(envelopeOf(state).root)).toBe(j(jmp(null, jmp(num(50), sym('xmm')))));
    expect(state.caret).toEqual(tokc([1, 1], 1));
    legal(state);
    let s = { ...state, caret: tokc([1, 1], 3) }; // walk to the run's end (movement, unlogged)
    const logs0 = s.log.length;
    s = backspace(s); // xmm → xm (D1)
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, jmp(num(50), sym('xm')))));
    expect(s.caret).toEqual(tokc([1, 1], 2));
    s = backspace(s); // xm → x
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, jmp(num(50), sym('x')))));
    expect(s.caret).toEqual(tokc([1, 1], 1));
    s = backspace(s); // the emptied symbol → the pending null cell (D1 token-death)
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, jmp(num(50), null))));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcm8ovm-0): the landing is the LEFT
    // neighbor's right edge — after the 50 — not the row seam
    expect(s.caret).toEqual(tokc([1, 0], 2));
    legal(s);
    s = backspace(s); // 50 → 5 (ordinary in-token char drop now, caret at 5's end)
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, jmp(num(5), null))));
    expect(s.caret).toEqual(tokc([1, 0], 1));
    s = backspace(s); // 5 dies → the inner row becomes all-null implicit → CASCADE kills the outer row too → EMPTY formula (OA-invisible-death)
    expect(j(envelopeOf(s).root)).toBe('null');
    expect(s.caret).toEqual({ kind: 'empty' });
    legal(s);
    expect(s.log.length).toBe(logs0 + 5); // one undo unit per Backspace key — the cascade is a single op
    expect(backspace(s)).toBe(s); // D4 silent no-op on the empty formula
  });

  it('the cascade stops at a visible ancestor: the all-null implicit row dies to the pending null (OA-pending-null), the surviving sibling stays', () => {
    let s = at(jmp(sym('a'), jmp(num(5), sym('x'))), tokc([1, 1], 1));
    s = backspace(s); // x dies
    expect(j(envelopeOf(s).root)).toBe(j(jmp(sym('a'), jmp(num(5), null))));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcmw6mq-9): the landing is the
    // left neighbor's right edge — after the 5
    expect(s.caret).toEqual(tokc([1, 0], 1));
    s = backspace(s); // 5 dies → the inner row is all-null implicit → dies; the outer row keeps a → pending null at cell 1
    expect(j(envelopeOf(s).root)).toBe(j(jmp(sym('a'), null)));
    // dogfood cluster 2026-11-11 re-pin (rec-mwcmw6mq-9): the cascade lands at
    // the surviving left token's right edge — after the "a"
    expect(s.caret).toEqual(tokc([0], 1));
    legal(s);
  });

  it('BS directly on an already-all-null implicit row (seeded state) kills it the same way', () => {
    const s = backspace(at(jmp(null, null), rowc([], 0)));
    expect(j(envelopeOf(s).root)).toBe('null');
    expect(s.caret).toEqual({ kind: 'empty' });
    legal(s);
  });

  it('an explicit all-null row keeps its visible glyph — unchanged (glyphSplice death on BS stands, no OA-invisible-death)', () => {
    const s = backspace(at(op('add', null, null), rowc([], 1)));
    expect(j(envelopeOf(s).root)).toBe('null');
    expect(s.caret).toEqual({ kind: 'empty' });
    legal(s);
  });
});

// ——— micro-fix cluster 2026-11-13 (log integral-testlog-cluster-2026-11-13T09-45-11-382Z) ———

describe('2026-11-13 micro-fix cluster — rec-mwe11hta-1 + rec-mwesfxub-7', () => {
  it('OA-promote-row-end (rec-mwe11hta-1): BS at the trailing-null seam of a nested row promotes the surviving ROW to its row-end border station (row [] #2), never into the trailing root’s radicand; the next BS then fires the D5 highlight', () => {
    // add[ add[1, ·√(50)], null ] with the caret at the outer trailing pending cell
    const seed = op('add', op('add', num(1), jmp(null, { type: 'root', radicand: num(50) })), null);
    const d = decideBackspace(envOf(seed), rowc([], 1));
    expect(d.kind).toBe('glyph');
    expect(d.caret).toEqual(rowc([], 2)); // NOT token [1,1,'radicand'] @2
    let s = backspace(at(seed, rowc([], 1)));
    expect(j(envelopeOf(s).root)).toBe(j(op('add', num(1), jmp(null, { type: 'root', radicand: num(50) }))));
    expect(s.caret).toEqual(rowc([], 2));
    legal(s);
    // the next BS at that station highlights the nested root structure (D5)
    const d2 = decideBackspace(envelopeOf(s), s.caret);
    expect(d2.kind).toBe('highlight');
    expect(d2.target).toEqual([1, 1]);
    const d3 = decideBackspace(envelopeOf(s), s.caret, { highlighted: [1, 1] });
    expect(d3.kind).toBe('delete-structure');
    s = applyOps(s, d3.ops);
    expect(j(envelopeOf(s).root)).toBe(j(op('add', num(1), null))); // the invisible all-null mul died with it (OA-invisible-death)
    legal(s);
  });

  it('OA-promote-row-end row-container extension (rec-mwe11hta-1): the multi-cell glyph splice at the row end also lands at the row-border station — flat, nested in a row cell, and via the parent seam — never into the radicand; the next BS then fires the D5 highlight on the root', () => {
    // flat: add[1, ·√50, null], BS at the trailing pending cell row [] #3
    let s = backspace(at(op('add', num(1), jmp(null, { type: 'root', radicand: num(50) }), null), rowc([], 3)));
    expect(j(envelopeOf(s).root)).toBe(j(op('add', num(1), jmp(null, { type: 'root', radicand: num(50) }))));
    expect(s.caret).toEqual(rowc([], 2)); // NOT token [1,1,'radicand'] @2
    legal(s);
    let d = decideBackspace(envelopeOf(s), s.caret);
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1, 1]);
    // nested in a row container: jmp[2, add[1, ·√50, null]], BS at row [1] #3
    s = backspace(at(jmp(num(2), op('add', num(1), jmp(null, { type: 'root', radicand: num(50) }), null)), rowc([1], 3)));
    expect(s.caret).toEqual(rowc([1], 2)); // NOT token [1,1,1,'radicand'] @2
    legal(s);
    d = decideBackspace(envelopeOf(s), s.caret);
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1, 1, 1]);
    // ...and via the parent seam behind the nested row cell: row [] #2
    s = backspace(at(jmp(num(2), op('add', num(1), jmp(null, { type: 'root', radicand: num(50) }), null)), rowc([], 2)));
    expect(s.caret).toEqual(rowc([1], 2));
    legal(s);
    d = decideBackspace(envelopeOf(s), s.caret);
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1, 1, 1]);
    // the confirm deletes the root with content (the all-null mul dies with it — OA-invisible-death)
    const d3 = decideBackspace(envelopeOf(s), s.caret, { highlighted: [1, 1, 1] });
    expect(d3.kind).toBe('delete-structure');
    s = applyOps(s, d3.ops);
    expect(j(envelopeOf(s).root)).toBe(j(jmp(num(2), op('add', num(1), null))));
    legal(s);
  });

  it('OA-sub-label-empty (rec-mwesfxub-7): BS in a sub label is char-wise down to the EMPTY label (the □ state); the next BS at the empty script unwraps — the sub dies, the base stays (S-102)', () => {
    let s = backspace(at(jmp(null, sub('x', '5')), tokc([1], 1, 'sub')));
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, sub('x', ''))));
    expect(s.caret).toEqual(tokc([1], 0, 'sub')); // before the □
    legal(s);
    s = backspace(s); // BS at the empty script → S-102 unwrap
    expect(j(envelopeOf(s).root)).toBe(j(jmp(null, sym('x'))));
    expect(s.caret).toEqual(rowc([], 2));
    legal(s);
    // the base label empties the same way; then the baseless sub dies outright
    let s2 = backspace(at(sub('a', 'x'), tokc([], 1, 'base')));
    expect(j(envelopeOf(s2).root)).toBe(j(sub('', 'x')));
    legal(s2);
    s2 = backspace(s2);
    expect(j(envelopeOf(s2).root)).toBe('null');
    expect(s2.caret).toEqual({ kind: 'empty' });
    legal(s2);
    // multi-char scripts still peel letter-wise (unchanged)
    const s3 = backspace(at(sub('x', 'abc'), tokc([], 3, 'sub')));
    expect(j(envelopeOf(s3).root)).toBe(j(sub('x', 'ab')));
    expect(s3.caret).toEqual(tokc([], 2, 'sub'));
    legal(s3);
  });
});
