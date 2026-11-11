// T9 — the keyless-structure insertion vocabulary (rework session 2b-2):
// root (square + general via mroot) and subscript, programmatic only.
// Pins: the owner's forward-grab ruling (right-of-caret → radicand, left
// stays in the row, caret at the radicand's beginning), everystation shape's
// tree + caret, fromJSON-legality of every intermediate, the one-op undo /
// redo round-trip, and the sub label typing surface (label token carets,
// T9's ruled caret shapes). No box, no palette — machinery only.

import { describe, expect, it } from 'vitest';
import { fromJSON, type Envelope, type NodeJson } from '../src/ast/index.js';
import {
  applyOp,
  caretResolvesIn,
  envelopeOf,
  initSession,
  insertRoot,
  insertSubscript,
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
const add = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'add', args });
const group = (child: NodeJson | null): NodeJson => ({ type: 'group', parens: 'always', child });
const rootn = (radicand: NodeJson | null, mroot = false): NodeJson =>
  mroot ? { type: 'root', radicand, mroot: true } : { type: 'root', radicand };
const sub = (base: string, s: string): NodeJson => ({ type: 'sub', base, sub: s });

const s = (ch: string): TypedToken => ({ t: 'leaf', node: { type: 'sym', name: ch } });
const d = (str: string): TypedToken => ({ t: 'leaf', node: { type: 'num', value: Number(str) } });

const j = (x: unknown): string => JSON.stringify(x);
const treeOf = (state: EditingState): NodeJson | null => envelopeOf(state).root;
const expectTree = (state: EditingState, expected: NodeJson | null): void => {
  expect(j(treeOf(state))).toBe(j(expected));
};
const expectLegal = (state: EditingState): void => {
  expect(() => fromJSON(envelopeOf(state))).not.toThrow();
  expect(caretResolvesIn(envelopeOf(state), state.caret)).toBe(true);
};

/** A seeded session with the caret placed (unlogged, host-style). */
const at = (root: NodeJson | null, caret: Caret): EditingState => ({ ...initSession({ v: 1, root }), caret });

describe('T9 — root insertion (the owner forward-grab ruling)', () => {
  it('empty formula: the □ radicand template, caret in it (square root = index-omitted v1)', () => {
    const next = insertRoot(initSession());
    expectTree(next, rootn(null));
    expect(next.caret).toEqual({ kind: 'slot', path: [], slot: 'radicand' });
    expect(next.log.length).toBe(1);
    expectLegal(next);
  });

  it('mroot empty formula: radicand □ + the EMPTY □ index slot (the mroot flag never combines with content)', () => {
    const next = insertRoot(initSession(), { mroot: true });
    expectTree(next, { type: 'root', radicand: null, mroot: true });
    expect(next.caret).toEqual({ kind: 'slot', path: [], slot: 'radicand' });
    expectLegal(next);
  });

  it('token caret at offset 0: the WHOLE token goes into the radicand, caret at its first text position', () => {
    const next = insertRoot(at(num(123), { kind: 'token', path: [], index: 0 }));
    expectTree(next, rootn(num(123)));
    expect(next.caret).toEqual({ kind: 'token', path: ['radicand'], index: 0 });
    expectLegal(next);
  });

  it('mid-token caret: right half under the radical, left half juxtaposed before it', () => {
    const next = insertRoot(at(num(123), { kind: 'token', path: [], index: 1 }));
    expectTree(next, imp(num(1), rootn(num(23))));
    expect(next.caret).toEqual({ kind: 'token', path: [1, 'radicand'], index: 0 });
    expectLegal(next);
    const onSym = insertRoot(at(sym('ab'), { kind: 'token', path: [], index: 1 }));
    expectTree(onSym, imp(sym('a'), rootn(sym('b'))));
    expect(onSym.caret).toEqual({ kind: 'token', path: [1, 'radicand'], index: 0 });
  });

  it('token caret at the END: nothing follows — the □ template juxtaposes after, caret in it', () => {
    const next = insertRoot(at(num(123), { kind: 'token', path: [], index: 3 }));
    expectTree(next, imp(num(123), rootn(null)));
    expect(next.caret).toEqual({ kind: 'slot', path: [1], slot: 'radicand' });
    expectLegal(next);
  });

  it('a seam grabs the right-adjacent node whole; the caret lands at the radicand beginning (deep content dives)', () => {
    const next = insertRoot(at(add(num(1), group(add(sym('a'), sym('b')))), { kind: 'row', path: [], index: 1 }));
    expectTree(next, add(num(1), rootn(group(add(sym('a'), sym('b'))))));
    // 4a re-pin (OA-visual-trumps): the radicand beginning is the group's
    // content-start bench — the first cell's in-token offset 0
    expect(next.caret).toEqual({ kind: 'token', path: [1, 'radicand', 'child', 0], index: 0 });
    expectLegal(next);
  });

  it('a caret IN a pending null cell: with a right operand it grabs it; without it parks the □ in the cell', () => {
    const grabbed = insertRoot(at(add(num(1), null, num(2)), { kind: 'row', path: [], index: 1 }));
    expectTree(grabbed, add(num(1), null, rootn(num(2))));
    expect(grabbed.caret).toEqual({ kind: 'token', path: [2, 'radicand'], index: 0 });
    expectLegal(grabbed);
    const pending = insertRoot(at(add(num(1), null), { kind: 'row', path: [], index: 1 }));
    expectTree(pending, add(num(1), rootn(null)));
    expect(pending.caret).toEqual({ kind: 'slot', path: [1], slot: 'radicand' });
    expectLegal(pending);
  });

  it('an after-station when a row cell follows grabs THAT cell; at a slot/root it juxtaposes the template', () => {
    const next = insertRoot(at(add(group(num(1)), num(9)), { kind: 'node', path: [0] }));
    expectTree(next, add(group(num(1)), rootn(num(9))));
    expect(next.caret).toEqual({ kind: 'token', path: [1, 'radicand'], index: 0 });
    const lone = insertRoot(at(group(num(1)), { kind: 'node', path: [] }));
    expectTree(lone, imp(group(num(1)), rootn(null)));
    expect(lone.caret).toEqual({ kind: 'slot', path: [1], slot: 'radicand' });
    expectLegal(lone);
  });

  it('a row END seam splices the □ template in as a fresh cell', () => {
    const next = insertRoot(at(add(num(1), num(2)), { kind: 'row', path: [], index: 2 }));
    expectTree(next, add(num(1), num(2), rootn(null)));
    expect(next.caret).toEqual({ kind: 'slot', path: [2], slot: 'radicand' });
    expectLegal(next);
  });

  it('mroot grabs forward identically; the index stays an EMPTY □ slot (never filled at insertion)', () => {
    const next = insertRoot(at(num(123), { kind: 'token', path: [], index: 1 }), { mroot: true });
    expectTree(next, imp(num(1), { type: 'root', radicand: num(23), mroot: true }));
    expect(next.caret).toEqual({ kind: 'token', path: [1, 'radicand'], index: 0 });
    expectLegal(next);
  });

  it('one insert = one op: undo unwinds the whole creation byte-exactly; redo re-applies', () => {
    const seed = at(num(123), { kind: 'token', path: [], index: 1 });
    const inserted = insertRoot(seed);
    const undone = undo(inserted);
    expectTree(undone, num(123));
    expect(undone.caret).toEqual(seed.caret);
    const redone = redo(undone);
    expectTree(redone, imp(num(1), rootn(num(23))));
    expect(redone.caret).toEqual(inserted.caret);
  });

  it('typing continues inside the grabbed radicand (fresh exponent-style growth is keyed, not grabbed)', () => {
    let next = insertRoot(at(sym('x'), { kind: 'token', path: [], index: 0 }));
    expect(next.caret).toEqual({ kind: 'token', path: ['radicand'], index: 0 });
    next = typeToken(next, d('2')); // the grabbed radicand is an ordinary typing surface
    expectTree(next, rootn(imp(num(2), sym('x')))); // the digit pairs before the symbol (T3)
    expectLegal(next);
  });
});

describe('T9 — subscript insertion (v1 label mode)', () => {
  it('a preceding symbol converts into the base (any offset — T5 shape); the caret lands in the empty script label', () => {
    const next = insertSubscript(at(sym('x'), { kind: 'node', path: [] }));
    expectTree(next, sub('x', ''));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 0, label: 'sub' });
    expectLegal(next);
  });

  it('typing letters fills the script label (the label caret surfaces the keyboard); digits join while the shape holds', () => {
    let next = insertSubscript(at(sym('x'), { kind: 'node', path: [] }));
    for (const ch of ['m', 'a', 'x'] as string[]) next = typeToken(next, s(ch));
    expectTree(next, sub('x', 'max'));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 3, label: 'sub' });
    next = typeToken(next, d('1'));
    expectTree(next, sub('x', 'max1'));
    expectLegal(next);
  });

  it('the empty template lands with the caret in the BASE label (the first thing typed); typing fills it', () => {
    let next = insertSubscript(initSession());
    expectTree(next, sub('', ''));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 0, label: 'base' });
    next = typeToken(next, s('v'));
    next = typeToken(next, d('2'));
    expectTree(next, sub('v2', ''));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 2, label: 'base' });
    expectLegal(next);
  });

  it('shape-breaking glues are silent no-ops: a digit cannot start a base; digits beyond the first char glue', () => {
    let next = insertSubscript(initSession());
    expect(typeToken(next, d('1')).caret).toEqual(next.caret); // silent no-op, nothing logged
    expect(typeToken(next, d('1')).log.length).toBe(next.log.length);
  });

  it('Left/Right step letter-wise within a label and cross base↔script at their seam; out at the outer ends', () => {
    const env: Envelope = { v: 1, root: add(sub('ab', 'max1'), num(9)) };
    const baseEnd: Caret = { kind: 'token', path: [0], index: 2, label: 'base' };
    expect(resolveMove(env, baseEnd, 'right')).toEqual({ kind: 'token', path: [0], index: 0, label: 'sub' });
    expect(resolveMove(env, { kind: 'token', path: [0], index: 0, label: 'sub' }, 'left')).toEqual(baseEnd);
    // 4a re-pin (N3 + OA-visual-trumps): the row's left border collapses — the
    // sub cell's base-start IS the formula start (the origin's own state; the op
    // clamps it to the no-op); the right exit rests at the R-flank
    expect(resolveMove(env, { kind: 'token', path: [0], index: 0, label: 'base' }, 'left')).toEqual({ kind: 'token', path: [0], index: 0, label: 'base' });
    // 4b-1 re-pin (OA-flank-stations): the script end IS the sub's right
    // edge — the glyph zone's R-flank station rests there, then crosses.
    expect(resolveMove(env, { kind: 'token', path: [0], index: 4, label: 'sub' }, 'right')).toEqual({ kind: 'node', path: [0], side: 'right' });
    expect(resolveMove(env, { kind: 'node', path: [0], side: 'right' } as Caret, 'right')).toEqual({ kind: 'token', path: [1], index: 0 });
  });

  it('the seam-left symbol converts (the row path); elsewhere the template places/fills per the T7 branches', () => {
    const conv = insertSubscript(at(add(sym('a'), sym('b')), { kind: 'row', path: [], index: 1 }));
    expectTree(conv, add(sub('a', ''), sym('b')));
    expect(conv.caret).toEqual({ kind: 'token', path: [0], index: 0, label: 'sub' });
    const fresh = insertSubscript(at(add(num(1), num(2)), { kind: 'row', path: [], index: 2 }));
    expectTree(fresh, add(num(1), num(2), sub('', '')));
    expect(fresh.caret).toEqual({ kind: 'token', path: [2], index: 0, label: 'base' });
    expectLegal(fresh);
  });

  it('a nonconverting token juxtaposes the template (pair per offset, the T3 rules); an after-station pairs it too', () => {
    const afterNum = insertSubscript(at(num(5), { kind: 'node', path: [] }));
    expectTree(afterNum, imp(num(5), sub('', '')));
    expect(afterNum.caret).toEqual({ kind: 'token', path: [1], index: 0, label: 'base' });
    const pending = insertSubscript(at(add(num(1), null), { kind: 'row', path: [], index: 1 }));
    expectTree(pending, add(num(1), sub('', '')));
    expect(pending.caret).toEqual({ kind: 'token', path: [1], index: 0, label: 'base' });
    expectLegal(pending);
  });

  it('empty + undo: one op restores the seed byte-exactly; redo re-applies', () => {
    const seed = at(sym('x'), { kind: 'node', path: [] });
    const inserted = insertSubscript(seed);
    const undone = undo(inserted);
    expectTree(undone, sym('x'));
    expect(undone.caret).toEqual(seed.caret);
    expectTree(redo(undone), sub('x', ''));
  });

  it('programmatically deletable: deleteAt removes the sub node like any cell content', () => {
    const seed = at(add(num(1), sub('x', 'max')), { kind: 'node', path: [1] });
    expect(() => fromJSON(envelopeOf(seed))).not.toThrow();
    const next = applyOp(seed, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } });
    expectTree(next, add(num(1)));
    expectLegal(next);
  });

  it('the sub node stays atomic as a NODE: a token caret without label never resolves on it', () => {
    expect(caretResolvesIn({ v: 1, root: sub('x', 'max') }, { kind: 'token', path: [], index: 1 })).toBe(false);
    expect(caretResolvesIn({ v: 1, root: sub('x', 'max') }, { kind: 'token', path: [], index: 1, label: 'sub' })).toBe(true);
  });

  it('no settle interplay: subscript insertion is not a unit-run leave mechanic (letters around subs untouched)', () => {
    const seed = at(imp(num(50), sym('mm')), { kind: 'node', path: [1] });
    const next = insertSubscript(seed);
    expectTree(next, imp(num(50), sub('mm', '')));
    expect(settleUnits(next)).toBe(next); // the converted pair shape is gone; unit-ness stays dead
    expectLegal(next);
  });
});


// ——— the head-less fence pair: D7's own re-typing surface (session-3 live check, B-22) ———

describe('S-077/S-086 re-binding — letters seed the head symbol, then `(` re-heads the content over the waiting fence', () => {
  const fenceTok: NodeJson = { type: 'fence', side: 'close' };
  const openTok: TypedToken = { t: 'groupOpen' };

  it('sin(a+b) after the head swap: |a+b) + c,o,s + ( → cos(a+b) — the whole pair re-binds as ONE fenced fn', () => {
    // the post-headDelete payload: the implicit pair [a+b, )] with the
    // caret at the pair's start seam (the D7 ruled re-typing workflow)
    let state = at(imp(add(sym('a'), sym('b')), fenceTok), { kind: 'row', path: [], index: 0 });
    state = typeToken(state, s('c')); // SEEDS the head symbol — never glues into the content
    expectTree(state, imp(sym('c'), add(sym('a'), sym('b')), fenceTok));
    state = typeToken(state, s('o')); // the inner seam grows the standing head
    state = typeToken(state, s('s'));
    expectTree(state, imp(sym('cos'), add(sym('a'), sym('b')), fenceTok));
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
    expect(state.log.length).toBe(3);
    // the `(` re-heads: the pair becomes one fenced fn over the content,
    // the fence token re-binding as its close (the S-097 completion shape)
    state = typeToken(state, openTok);
    expectTree(state, { type: 'fn', name: 'cos', args: [add(sym('a'), sym('b'))] });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 0 });
    expect(state.log.length).toBe(4);
    expectLegal(state);
    // undo unwinds the whole re-heading as one log unit (U2)
    state = undo(state);
    expectTree(state, imp(sym('cos'), add(sym('a'), sym('b')), fenceTok));
    expectLegal(state);
  });

  it('a single-symbol content re-heads equally (the head swap of sin(x) → x) + cos( → cos(x))', () => {
    let state = at(imp(sym('x'), fenceTok), { kind: 'row', path: [], index: 0 });
    state = typeToken(state, s('c'));
    state = typeToken(state, s('o'));
    state = typeToken(state, s('s'));
    expectTree(state, imp(sym('cos'), sym('x'), fenceTok));
    state = typeToken(state, openTok);
    expectTree(state, { type: 'fn', name: 'cos', args: [sym('x')] });
    expectLegal(state);
  });
});
