// Consolidated cleanup session (2026-11-10) — the banked live-check fix list,
// engine-level byte pins. One describe per owner ruling; every pin names its
// rule ID at the site. The DOM/overlay halves live in cleanup-oa-dom.test.ts.

import { describe, expect, it } from 'vitest';

import {
  applyOp,
  backspace,
  decideBackspace,
  decideDelete,
  envelopeOf,
  forwardDelete,
  initSession,
  resolveMove,
  typeToken,
  type Caret,
  type EditingState,
  type Envelope,
  type NavDir,
} from '../src/engine/index.js';
import { applyVerticalKey, regionKey, type VerticalMemory } from '../src/editor/vertical-memory.js';

const j = (x: unknown): string => JSON.stringify(x);
const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const op = (o: string, ...args: unknown[]) => ({ type: 'op', op: o, args });
const frac = (n: unknown, d: unknown) => ({ type: 'frac', num: n, den: d });
const rowc = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path: path as never, index });
const tok = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path: path as never, index });
const node = (path: (number | string)[], side?: 'left' | 'right'): Caret =>
  ({ kind: 'node', path: path as never, ...(side !== undefined ? { side } : {}) });
const slot = (path: (number | string)[], s: string): Caret => ({ kind: 'slot', path: path as never, slot: s as never });
const envRoot = (root: unknown): Envelope => ({ v: 1, root: root as never });
const at = (root: unknown, caret: Caret): EditingState => ({ ...initSession({ v: 1, root: root as never }), caret });
const envMoved = (root: unknown, caret: Caret, dir: NavDir): Caret | null => resolveMove(envRoot(root), caret, dir);
const imp = (a: unknown, b: unknown) => ({ type: 'op', op: 'multiply', args: [a, b], implicit: true });

describe('cleanup — OA-del-glyph (ruled 2026-11-10): forward Delete at an operator gap removes the binding glyph', () => {
  it('x+|y + Del → the pair x·y, caret at y@0 (the BS glyph-delete mirror)', () => {
    const root = op('add', sym('x'), sym('y'));
    const d = decideDelete(envRoot(root), rowc([], 1));
    expect(d.kind).toBe('glyph'); // OA-del-glyph
    const s = forwardDelete(at(root, rowc([], 1)));
    expect(j(envelopeOf(s).root)).toBe(j(imp(sym('x'), sym('y'))));
    expect(s.caret).toEqual(tok([1], 0));
    expect(s.log.length).toBe(1);
  });

  it('the M-15 #2 stall case: x + |1/2 + y — Del at the seam before the fraction removes the first `+`', () => {
    const root = op('add', sym('x'), frac(num(1), num(2)), sym('y'));
    const d = decideDelete(envRoot(root), rowc([], 1));
    expect(d.kind).toBe('glyph'); // OA-del-glyph — no longer the parked no-op
    const s = forwardDelete(at(root, rowc([], 1)));
    expect(j(envelopeOf(s).root)).toBe(j(op('add', imp(sym('x'), frac(num(1), num(2))), sym('y'))));
    expect(s.caret).toEqual(tok([0, 1, 'num'], 0));
  });

  it('Del at a mid-row structure’s RIGHT flank faces the glyph zone ahead (same rule)', () => {
    const root = op('add', sym('x'), frac(num(1), num(2)), sym('y'));
    const d = decideDelete(envRoot(root), node([1], 'right'));
    expect(d.kind).toBe('glyph'); // OA-del-glyph — the parked flank no-op is superseded
    const s = forwardDelete(at(root, node([1], 'right')));
    expect(j(envelopeOf(s).root)).toBe(j(op('add', sym('x'), imp(frac(num(1), num(2)), sym('y')))));
    expect(s.caret).toEqual(tok([1, 1], 0));
  });

  it('the named no-ops stay: dangling glyph / pending cell / row end / □ slot; Ctrl+Del keeps the D3 whole-token mirror', () => {
    expect(decideDelete(envRoot(op('add', sym('x'), null)), rowc([], 1)).kind).toBe('noop');
    expect(decideDelete(envRoot(op('add', sym('x'), sym('y'))), rowc([], 2)).kind).toBe('noop');
    expect(decideDelete(envRoot(frac(null, num(2))), slot([], 'num')).kind).toBe('noop');
    // ctrl at a binding-glyph seam: the D3 mirror (whole right token), not the glyph
    const d = decideDelete(envRoot(op('add', sym('x'), sym('yz'))), rowc([], 1), { ctrl: true });
    expect(d.kind).toBe('token-death');
    // glyph-less (implicit) seam keeps the D1 first-char mirror
    const gl = forwardDelete(at(imp(sym('x'), sym('yz')), rowc([], 1)));
    expect(j(envelopeOf(gl).root)).toBe(j(imp(sym('x'), sym('z'))));
    expect(gl.caret).toEqual(rowc([], 1));
  });
});

describe('cleanup — OA-closeparen-exit (ruled 2026-11-10): a retyped close paren landing is the group’s right flank INSIDE the enclosing structure', () => {
  const openGroup = (child: unknown) => ({ type: 'group', parens: 'always', close: false, child });

  it('the M-12/S-097 case: 1/(a+b| + `)` lands at node(["den"],"right") — never right of the whole fraction', () => {
    const root = { type: 'frac', num: num(1), den: openGroup(op('add', sym('a'), sym('b'))) };
    const s = typeToken(at(root, tok(['den', 'child', 1], 1)), { t: 'groupClose' });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'frac', num: num(1), den: { type: 'group', parens: 'always', child: op('add', sym('a'), sym('b')) } }));
    expect(s.caret).toEqual(node(['den'], 'right')); // OA-closeparen-exit
  });

  it('mid-row: x + (a+b| + `)` lands at the group’s right flank node([1],"right")', () => {
    const root = op('add', sym('x'), openGroup(op('add', sym('a'), sym('b'))), sym('y'));
    const s = typeToken(at(root, tok([1, 'child', 1], 1)), { t: 'groupClose' });
    expect(s.caret).toEqual(node([1], 'right')); // OA-closeparen-exit
  });

  it('a bare root group lands at the lone-root after-station node([],"right") (unchanged)', () => {
    const root = openGroup(sym('a'));
    const s = typeToken(at(root, tok(['child'], 1)), { t: 'groupClose' });
    expect(s.caret).toEqual(node([], 'right'));
  });

  it('an fn close in a slot: 1/sin(a| + `)` lands inside the denominator at the fn’s right flank', () => {
    const root = {
      type: 'frac', num: num(1),
      den: { type: 'fn', name: 'sin', args: [sym('a')], close: false },
    };
    const s = typeToken(at(root, tok(['den', 0], 1)), { t: 'groupClose' });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'frac', num: num(1), den: { type: 'fn', name: 'sin', args: [sym('a')] } }));
    expect(s.caret).toEqual(node(['den'], 'right')); // OA-closeparen-exit
  });
});

describe('cleanup — OA-sinarg-merge (ruled 2026-11-10): the fn argument start and the painting row seam are ONE station (D7b extends)', () => {
  const SIN_AB = { type: 'fn', name: 'sin', args: [op('add', sym('a'), sym('b'))] };

  it('BS at the arg-content-start landing token [0,0] @0 acts exactly as the row seam row [] #0 (D7b head delete)', () => {
    const atSeam = decideBackspace(envRoot(SIN_AB), rowc([], 0), {});
    const atToken = decideBackspace(envRoot(SIN_AB), tok([0, 0], 0), {});
    expect(atSeam.kind).toBe('open-fence'); // D7b
    expect(atToken.kind).toBe('open-fence'); // OA-sinarg-merge — no silent no-op
    expect(j(atToken.ops)).toBe(j(atSeam.ops));
    expect(j(atToken.caret)).toBe(j(atSeam.caret));
    // and it applies: the head dies, content + `)` survive as the pair
    let s = at(SIN_AB, tok([0, 0], 0));
    for (const o of atToken.ops) s = applyOp(s, o as never);
    expect(j(envelopeOf(s).root)).toBe(
      j(imp(op('add', sym('a'), sym('b')), { type: 'fence', side: 'close' })),
    );
    expect(s.caret).toEqual(rowc([], 0)); // the payload’s outer seam (twin collapse)
  });

  it('the empty first argument keeps the □ reading (S-023 A) at both stations', () => {
    const empty = { type: 'fn', name: 'sin', args: [null] };
    expect(decideBackspace(envRoot(empty), rowc([], 0), {}).kind).toBe('container-death');
  });
});

describe('cleanup — OA-unit-single-seam (ruled live 2026-11-10): one seam at 50|mm; the typed key decides the channel', () => {
  const U = { type: 'unit', value: num(50), unit: 'mm' };

  it('the walk has ONE stop at the value/label boundary: |50 mm → 5|0 mm → 50|mm → 50 m|m → 50 mm|', () => {
    expect(envMoved(U, tok(['value'], 0), 'right')).toEqual(tok(['value'], 1));
    expect(envMoved(U, tok(['value'], 1), 'right')).toEqual(tok([], 0)); // OA-unit-single-seam: no value-end stop
    expect(envMoved(U, tok([], 0), 'right')).toEqual(tok([], 1));
    expect(envMoved(U, tok([], 1), 'right')).toEqual(tok([], 2));
    expect(envMoved(U, tok([], 2), 'right')).toBe(null);
    expect(envMoved(U, tok([], 0), 'left')).toEqual(tok(['value'], 1)); // ← back to the value’s last interior offset
    expect(envMoved(U, tok(['value'], 0), 'left')).toBe(null);
  });

  it('digit/dot at either edge state goes to the VALUE channel; letter at the value end goes to the LABEL channel', () => {
    // `50 mm|` + 5 → 505 mm, caret in the value (OA-unit-single-seam)
    let s = typeToken(at(U, tok([], 2)), { t: 'leaf', node: num(5) });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: num(505), unit: 'mm' }));
    expect(s.caret).toEqual(tok(['value'], 3));
    // `50|mm` + 5 → the same (the seam is one station)
    s = typeToken(at(U, tok([], 0)), { t: 'leaf', node: num(5) });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: num(505), unit: 'mm' }));
    expect(s.caret).toEqual(tok(['value'], 3));
    // `50 mm|` + `.` → 50. mm
    s = typeToken(at(U, tok([], 2)), { t: 'dot' });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: { type: 'num', value: 50, dot: true }, unit: 'mm' }));
    expect(s.caret).toEqual(tok(['value'], 3));
    // a letter at the value’s end (click-placed `50| mm`) prepends to the label; unknown reverts (S-104)
    s = typeToken(at(U, tok(['value'], 2)), { t: 'leaf', node: sym('x') });
    expect(j(envelopeOf(s).root)).toBe(j(imp(num(50), sym('xmm'))));
    expect(s.caret).toEqual(tok([1], 1));
    // a still-known letter prepended at the seam stays attached (m + m → mm)
    const U1 = { type: 'unit', value: num(50), unit: 'm' };
    s = typeToken(at(U1, tok(['value'], 2)), { t: 'leaf', node: sym('m') });
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: num(50), unit: 'mm' }));
    expect(s.caret).toEqual(tok([], 1));
  });

  it('BS/Del at the seam act on the adjacent characters (no jump to the row rules)', () => {
    // BS at `50|mm` peels the value’s last char → `5|0 mm`... caret at value len-1
    let s = at(U, tok([], 0));
    s = backspace(s);
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: num(5), unit: 'mm' }));
    expect(s.caret).toEqual(tok(['value'], 1)); // `5|mm` — the value’s end after the peel
    // Del at `50| mm` (value end, click-placed) removes the label’s first char → 50 m
    s = forwardDelete(at(U, tok(['value'], 2)));
    expect(j(envelopeOf(s).root)).toBe(j({ type: 'unit', value: num(50), unit: 'm' }));
    expect(s.caret).toEqual(tok(['value'], 2));
    // mid-row: BS at the seam no longer eats the row’s left glyph
    const mid = op('add', sym('a'), U, sym('b'));
    s = backspace(at(mid, tok([1], 0)));
    expect(j(envelopeOf(s).root)).toBe(j(op('add', sym('a'), { type: 'unit', value: num(5), unit: 'mm' }, sym('b'))));
    expect(s.caret).toEqual(tok([1, 'value'], 1)); // the value's end after the peel
  });
});

describe('cleanup — twin collapses (OA-visual-trumps): one producer per visual spot', () => {
  it('rowEndStation sees through an op-row border cell: V-16’s pair start is one spot (← at token [0,0] @0 clamps to a no-op)', () => {
    const v16 = { type: 'op', op: 'multiply', args: [imp(num(5), sym('x')), num(3)] };
    // was row([],0) — the twin seam; now the border resolves to the same
    // in-token state, so the press is the defined same-state no-op
    expect(j(envMoved(v16, tok([0, 0], 0), 'left'))).toBe(j(tok([0, 0], 0)));
    expect(j(envMoved(v16, tok([1], 1), 'right'))).toBe(j(tok([1], 1))); // the 3’s in-token end IS the row end
    // a text-first root row: the border seam collapses onto the in-token edge
    const ab = op('add', sym('ab'), sym('c'));
    expect(j(envMoved(ab, tok([1], 1), 'right'))).toBe(j(tok([1], 1)));
  });

  it('the open-fence/head-delete payload lands on the OUTER row seam (row [0] #0 vs row [] #0 collapsed)', () => {
    const root = op('add', sym('x'), { type: 'group', parens: 'always', child: sym('b') }, sym('y'));
    const d = decideDelete(envRoot(root), node([1], 'left')); // OA-fence-flank: removes the `(`
    expect(d.kind).toBe('open-fence');
    expect(d.caret).toEqual(rowc([], 1)); // the outer seam before the payload cell — not the pair’s inner row([1],0)
  });
});

describe('cleanup — M-17 fix: the vmem nesting chain wins over the arrival region’s own store on descents', () => {
  const NEST = {
    type: 'frac', num: num(1),
    den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [num(2), { type: 'frac', num: num(3), den: num(4) }] } },
  };
  const env = envRoot(NEST);
  const AT_PLUS = tok(['den', 'child', 0], 1);
  const AT_3 = tok(['den', 'child', 1, 'num'], 0);
  const NEST_NUM = regionKey({ parentPath: ['den', 'child', 1], slot: 'num' });

  it('the owner’s live sequence on ONE memory: scenario 1 first (big-den store), then into the nested 3 — ↑↓ still retraces to the 3', () => {
    let mem: VerticalMemory = new Map();
    // scenario 1: at the +, ↑↓ → back at the + (big-den’s own store)
    const up1 = applyVerticalKey(env, AT_PLUS, 'up', mem);
    const down1 = applyVerticalKey(env, up1.caret, 'down', up1.mem);
    expect(down1.fired).toBe(true);
    expect(j(down1.caret)).toBe(j(AT_PLUS));
    mem = down1.mem;
    // → → into the nested fraction’s numerator (at the 3), then ↑ (stores the nested num)
    const up2 = applyVerticalKey(env, AT_3, 'up', mem);
    expect(j(up2.mem.get(NEST_NUM))).toBe(j(AT_3));
    // ↓ from the big numerator: the CHAIN wins over the big-den’s own store (the +) — the M-17 live fix
    const down2 = applyVerticalKey(env, up2.caret, 'down', up2.mem);
    expect(down2.fired).toBe(true);
    expect(j(down2.caret)).toBe(j(AT_3)); // "the nested layer’s own memory doing its job" — now also live
  });

  it('the fresh-memory scenarios keep their pinned behavior (chain only when it resolves)', () => {
    let mem: VerticalMemory = new Map();
    const up = applyVerticalKey(env, AT_PLUS, 'up', mem);
    const down = applyVerticalKey(env, up.caret, 'down', up.mem);
    expect(j(down.caret)).toBe(j(AT_PLUS)); // no nested store yet → the own store fires
  });
});

describe('cleanup — the mroot □-index flag-drop (K-12/K-17)', () => {
  it('typing a digit fills the index and drops mroot; a structure key does the same; the flag survives only while the slot is empty', () => {
    const s = initSession({ v: 1, root: { type: 'root', radicand: num(5), mroot: true } as never });
    const d = typeToken(s, { t: 'leaf', node: num(3) });
    expect(j(envelopeOf(d).root)).toBe(j({ type: 'root', radicand: num(5), index: num(3) }));
    expect(d.caret).toEqual(tok(['index'], 1));
    const s2 = initSession({ v: 1, root: { type: 'root', radicand: num(5), mroot: true } as never });
    const dv = typeToken(s2, { t: 'divide' });
    expect(j(envelopeOf(dv).root)).toBe(j({ type: 'root', radicand: num(5), index: { type: 'frac', num: null, den: null } }));
    expect(dv.caret).toEqual(slot(['index'], 'num'));
  });
});
