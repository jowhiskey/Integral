// Rework session 5 — U1 undo coalescing (engine half) + the K1 Home/End
// resolver. Engine-level pins, no DOM: the LogEntry {ops:[…]} shape, applyOps
// multi-op units, the extendOpenUnit merge, typeToken's coalesce flag (incl.
// the S-085 structural split at the T5 conversion), undo/redo under the new
// shape (U2/U3/U4 re-pinned), and resolveBoundary (K1) pure pins.

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/ast/index.js';
import {
  applyOp,
  applyOps,
  backspace,
  envelopeOf,
  initSession,
  redo,
  resolveBoundary,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type Envelope,
} from '../src/engine/index.js';
import { KEYMAP } from '../src/editor/keys.js';

const j = (x: unknown): string => JSON.stringify(x);
const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const tok = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const rowc = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const sl = (path: (number | string)[], slot: string): Caret => ({ kind: 'slot', path, slot: slot as never });
const envOf = (root: unknown): Envelope => ({ v: 1, root: root as never });
const K = (ch: string) => KEYMAP[ch]!;

describe('session 5 — LogEntry shape {ops:[…]} and applyOps units', () => {
  it('a single-op action produces a one-op array; the entry carries the pre-unit snapshots', () => {
    const s0 = initSession();
    const op = { op: 'insert', node: num(5), at: { at: 'root' } } as const;
    const s1 = applyOp(s0, op);
    expect(s1.log.length).toBe(1);
    const entry = s1.log[0];
    expect(entry.ops).toEqual([op]);
    expect(j(entry.before)).toBe(j({ v: 1, root: null }));
    expect(entry.caretBefore).toEqual({ kind: 'empty' });
  });

  it('applyOps applies a list as ONE unit: one entry, ops array, pre-unit snapshots; undo/redo byte-exact', () => {
    let s = initSession();
    s = applyOps(s, [
      { op: 'insert', node: { type: 'op', op: 'add', args: [num(5)] }, at: { at: 'root' } },
      { op: 'insert', node: num(3), at: { at: 'row', path: [], index: 1 } },
    ]);
    expect(s.log.length).toBe(1);
    expect(s.log[0].ops.length).toBe(2);
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [num(5), num(3)] }));
    const after = s;
    const afterSnap = j([envelopeOf(s), s.caret, s.log]);

    const undone = undo(after);
    expect(j(envelopeOf(undone).root)).toBe('null');
    expect(undone.caret).toEqual({ kind: 'empty' });
    expect(undone.log.length).toBe(0);
    expect(undone.redo.length).toBe(1);
    expect(undone.redo[0]).toEqual(after.log[0]);

    const redone = redo(undone);
    expect(j([envelopeOf(redone), redone.caret, redone.log])).toBe(afterSnap); // byte-exact incl. the re-logged unit
    expect(redone.log.length).toBe(1);
    expect(redone.log[0].ops.length).toBe(2);
    expect(redone.redo.length).toBe(0);
  });

  it('applyOps([]) is the same state object; undo/redo on empty stacks are silent no-ops (U4 re-pin)', () => {
    const s = initSession();
    expect(applyOps(s, [])).toBe(s);
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });

  it('extendOpenUnit merges into the last entry, keeping the pre-run snapshots; a new unit clears redo (U3)', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: { type: 'op', op: 'add', args: [num(5)] }, at: { at: 'root' } });
    const before0 = s.log[0];
    // extend: same entry, ops appended, before/caretBefore untouched
    s = applyOp(s, { op: 'insert', node: num(3), at: { at: 'row', path: [], index: 1 } }, { extendOpenUnit: true });
    expect(s.log.length).toBe(1);
    expect(s.log[0].ops.length).toBe(2);
    expect(s.log[0].before).toEqual(before0.before);
    expect(s.log[0].caretBefore).toEqual(before0.caretBefore);
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'op', op: 'add', args: [num(5), num(3)] }));

    // without the flag: a new entry
    s = applyOp(s, { op: 'insert', node: sym('x'), at: { at: 'row', path: [], index: 2 } });
    expect(s.log.length).toBe(2);
    expect(s.log[1].ops.length).toBe(1);

    // extend on an empty log starts a new entry
    let s3 = initSession();
    s3 = applyOp(s3, { op: 'insert', node: num(1), at: { at: 'root' } }, { extendOpenUnit: true });
    expect(s3.log.length).toBe(1);
    expect(s3.log[0].ops.length).toBe(1);

    // an extending edit clears the redo list (U3)
    let s4 = initSession();
    s4 = applyOp(s4, { op: 'insert', node: num(5), at: { at: 'root' } });
    s4 = undo(s4);
    expect(s4.redo.length).toBe(1);
    s4 = applyOp(s4, { op: 'insert', node: num(7), at: { at: 'root' } }, { extendOpenUnit: true });
    expect(s4.redo.length).toBe(0);
  });
});

describe('session 5 — U1 typing-run coalescing via typeToken’s coalesce flag', () => {
  it('coalesced typing extends one entry; an unflagged typeToken starts a new unit', () => {
    let s = initSession();
    s = typeToken(s, K('a'), { coalesce: true });
    s = typeToken(s, K('b'), { coalesce: true });
    expect(s.log.length).toBe(1);
    expect(s.log[0].ops.length).toBe(2);
    expect(j(envelopeOf(s).root)).toBe(j(sym('ab')));
    s = typeToken(s, K('c')); // no flag → new unit
    expect(s.log.length).toBe(2);
    expect(s.log[1].ops.length).toBe(1);
    // undo walks the units: abc → ab → empty
    let u = undo(s);
    expect(j(envelopeOf(u).root)).toBe(j(sym('ab')));
    u = undo(u);
    expect(j(envelopeOf(u).root)).toBe('null');
    expect(u.log.length).toBe(0);
    // redo replays the coalesced unit byte-exactly
    let r = redo(u);
    expect(j(envelopeOf(r).root)).toBe(j(sym('ab')));
    expect(r.log[0].ops.length).toBe(2);
    r = redo(r);
    expect(j([envelopeOf(r), r.caret, j(r.log)])).toBe(j([envelopeOf(s), s.caret, j(s.log)]));
  });

  it('S-085: the T5 function conversion SPLITS the run even with coalesce set — `(`+conversion is its own unit', () => {
    let s = initSession();
    s = typeToken(s, K('s'), { coalesce: true });
    s = typeToken(s, K('i'), { coalesce: true });
    s = typeToken(s, K('n'), { coalesce: true });
    expect(s.log.length).toBe(1);
    expect(s.log[0].ops.length).toBe(3);
    expect(j(envelopeOf(s).root)).toBe(j(sym('sin')));
    // the `(` press converts sin → fn head: structural emission → new entry despite coalesce
    s = typeToken(s, K('('), { coalesce: true });
    expect(s.log.length).toBe(2);
    expect(s.log[1].ops.length).toBe(1);
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'fn', name: 'sin', args: [null] }));
    // undo of the conversion unit reverts to the BARE SYMBOL alone (no leftover empty group)
    const u = undo(s);
    expect(j(envelopeOf(u).root)).toBe(j(sym('sin')));
    expect(u.caret).toEqual(tok([], 3));
  });

  it('S-086 shape: a rebind `(` (head-less fence pair, OA-rehead) coalesces with the letter run', () => {
    // seed sin(a+b), delete the head at the arg start (one op), retype cos( — the
    // rebind `(` is NOT structural, so c,o,s,( land in one unit
    let s = initSession(envOf({ type: 'fn', name: 'sin', args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }] }));
    s = applyOp(s, { op: 'moveCaret', to: rowc([], 0) });
    s = backspace(s);
    const afterBs = s;
    expect(j(envelopeOf(s).root)).toContain('fence');
    const logLenAfterBs = s.log.length;
    // emulate the controller: the first typing key after the Backspace starts a
    // new run (no coalesce); the rest extend it — incl. the rebind `(`
    s = typeToken(s, K('c'));
    for (const ch of ['o', 's', '(']) s = typeToken(s, K(ch), { coalesce: true });
    expect(j(envelopeOf(s).root)).toBe(
      j({ type: 'fn', name: 'cos', args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }] }),
    );
    expect(s.log.length).toBe(logLenAfterBs + 1); // the whole `cos(` retype is ONE unit
    expect(s.log[s.log.length - 1].ops.length).toBe(4);
    // undo removes the typed cos( head in one step; the next undo restores the sin( head
    let u = undo(s);
    expect(j([envelopeOf(u), u.caret, j(u.log)])).toBe(j([envelopeOf(afterBs), afterBs.caret, j(afterBs.log)]));
    u = undo(u);
    expect(j(envelopeOf(u).root)).toBe(
      j({ type: 'fn', name: 'sin', args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }] }),
    );
  });

  it('U2 re-pin: one undo unwinds a structure creation incl. the node-grab (S-083)', () => {
    let s = initSession();
    s = typeToken(s, K('b'));
    s = typeToken(s, K('/')); // T7: grabs b into the numerator, □ denominator
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'frac', num: sym('b'), den: null }));
    expect(s.log.length).toBe(2);
    const u = undo(s);
    expect(j(envelopeOf(u).root)).toBe(j(sym('b'))); // b back in the row
    expect(u.caret).toEqual(tok([], 1)); // caret restored
  });
});

describe('session 5 — rider: the mroot □-index typing rejection is a typed ValidationError at engine level', () => {
  it('typing at an mroot empty index fills the index, leaves the flag, and the fromJSON gate rejects', () => {
    const s = initSession(envOf({ type: 'root', radicand: num(5), mroot: true }));
    expect(s.caret).toEqual(sl([], 'index')); // the seed pends in the □ index
    let caught: unknown;
    try {
      typeToken(s, K('5'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).name).toBe('ValidationError');
    expect((caught as Error).message).toContain('mroot');
  });
});

describe('session 5 — K1: resolveBoundary (Home/End) pure pins', () => {
  const flat = envOf({ type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] });
  const nested = envOf({
    type: 'op',
    op: 'add',
    args: [sym('x'), { type: 'frac', num: num(1), den: { type: 'op', op: 'add', args: [num(2), sym('abc')] } }, sym('z')],
  });
  const fnEnv = envOf({ type: 'fn', name: 'sin', args: [sym('x'), sym('y')] });

  it('flat row: End/Home walk the row ends; at the formula boundary they are no-ops (null)', () => {
    expect(j(resolveBoundary(flat, rowc([], 1), 'end'))).toBe(j(tok([2], 1))); // c's end
    expect(j(resolveBoundary(flat, tok([2], 1), 'end'))).toBe('null'); // already at the formula end
    expect(j(resolveBoundary(flat, tok([2], 1), 'start'))).toBe(j(tok([2], 0)));
    expect(j(resolveBoundary(flat, tok([2], 0), 'start'))).toBe(j(tok([0], 0))); // row start = formula start
    expect(j(resolveBoundary(flat, tok([0], 0), 'start'))).toBe('null');
    expect(j(resolveBoundary(flat, tok([1], 1), 'start'))).toBe(j(tok([1], 0))); // in-token first
  });

  it('nested slot: in-token → slot row → enclosing row directly (S-105 A); never a sibling slot', () => {
    const mid = tok([1, 'den', 1], 1); // mid "abc"
    expect(j(resolveBoundary(nested, mid, 'end'))).toBe(j(tok([1, 'den', 1], 3))); // abc end (local)
    // next press: DIRECTLY to the enclosing row's end (z's end) — not the frac's right flank
    expect(j(resolveBoundary(nested, tok([1, 'den', 1], 3), 'end'))).toBe(j(tok([2], 1)));
    expect(j(resolveBoundary(nested, tok([2], 1), 'end'))).toBe('null'); // formula end
    // Home from mid-abc: local token start, then the den row's start (the 2), then the enclosing row's start (x)
    expect(j(resolveBoundary(nested, mid, 'start'))).toBe(j(tok([1, 'den', 1], 0)));
    expect(j(resolveBoundary(nested, tok([1, 'den', 1], 0), 'start'))).toBe(j(tok([1, 'den', 0], 0)));
    expect(j(resolveBoundary(nested, tok([1, 'den', 0], 0), 'start'))).toBe(j(tok([0], 0)));
    expect(j(resolveBoundary(nested, tok([0], 0), 'start'))).toBe('null');
    // from the numerator: End never dives into the denominator (sibling slot)
    expect(j(resolveBoundary(nested, tok([1, 'num'], 0), 'end'))).toBe(j(tok([1, 'num'], 1)));
    expect(j(resolveBoundary(nested, tok([1, 'num'], 1), 'end'))).toBe(j(tok([2], 1)));
  });

  it('fn args: End from the last argument escalates to the fn’s after-station (past the close fence)', () => {
    expect(j(resolveBoundary(fnEnv, tok([1], 0), 'end'))).toBe(j(tok([1], 1)));
    expect(j(resolveBoundary(fnEnv, tok([1], 1), 'end'))).toBe(j({ kind: 'node', path: [], side: 'right' }));
    expect(j(resolveBoundary(fnEnv, { kind: 'node', path: [], side: 'right' }, 'end'))).toBe('null');
    expect(j(resolveBoundary(fnEnv, { kind: 'node', path: [], side: 'right' }, 'start'))).toBe(
      j({ kind: 'node', path: [], side: 'left' }),
    );
    expect(j(resolveBoundary(fnEnv, { kind: 'node', path: [], side: 'left' }, 'start'))).toBe('null');
  });

  it('lone pow: the base→exp horizontal chain is one visual row; the formula start is the base’s in-token start (the retired before-station, T-11)', () => {
    const powEnv = envOf({ type: 'pow', base: sym('a'), exp: num(2) });
    // Home from the exponent's start → the chain's start = the base's in-token start
    expect(j(resolveBoundary(powEnv, tok(['exp'], 0), 'start'))).toBe(j(tok(['base'], 0)));
    expect(j(resolveBoundary(powEnv, tok(['base'], 0), 'start'))).toBe('null'); // formula start reached
    // End from the base's end → the chain's end = the exponent's end, then the after-station
    expect(j(resolveBoundary(powEnv, tok(['base'], 1), 'end'))).toBe(j(tok(['exp'], 1)));
    expect(j(resolveBoundary(powEnv, tok(['exp'], 1), 'end'))).toBe(j({ kind: 'node', path: [], side: 'right' }));
    expect(j(resolveBoundary(powEnv, { kind: 'node', path: [], side: 'right' }, 'end'))).toBe('null');
  });

  it('empty slot (□): its own boundary is the slot caret — Home/End escalate to the container’s border stations', () => {
    const fracEnv = envOf({ type: 'frac', num: null, den: num(2) });
    expect(j(resolveBoundary(fracEnv, sl([], 'num'), 'start'))).toBe(j({ kind: 'node', path: [], side: 'left' }));
    expect(j(resolveBoundary(fracEnv, sl([], 'num'), 'end'))).toBe(j({ kind: 'node', path: [], side: 'right' }));
    // the denominator is never a target from the numerator slot
    expect(j(resolveBoundary(fracEnv, sl([], 'num'), 'end'))).not.toContain('den');
  });

  it('empty formula: null (defined no-op)', () => {
    expect(resolveBoundary({ v: 1, root: null }, { kind: 'empty' }, 'start')).toBe(null);
    expect(resolveBoundary({ v: 1, root: null }, { kind: 'empty' }, 'end')).toBe(null);
  });
});
