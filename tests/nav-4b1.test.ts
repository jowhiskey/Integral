// Rework session 4b-1 — caret-geometry completion, the engine-side
// acceptance: the flank stations (OA-flank-stations), the fence flanks
// (OA-fence-flank), the twin-elimination corollary pins, the
// OA-index-horizontal reach, and the M-04 D5 pin. Every pin names its rule.

import { describe, expect, it } from 'vitest';

import { isEvaluable } from '../src/ast/index.js';
import {
  applyOp,
  caretResolvesIn,
  decideBackspace,
  decideDelete,
  initSession,
  insertRoot,
  insertSubscript,
  resolveMove,
  settleUnits,
  typeToken,
  type Caret,
  type EditingState,
  type Envelope,
  type NavDir,
} from '../src/engine/index.js';

const j = (x: unknown): string => JSON.stringify(x);
const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const tok = (path: (number | string)[], index: number, label?: 'base' | 'sub'): Caret => ({
  kind: 'token', path: path as never, index, ...(label !== undefined ? { label } : {}),
});
const seam = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path: path as never, index });
const slot = (path: (number | string)[], s: string): Caret => ({ kind: 'slot', path: path as never, slot: s as never });
const node = (path: (number | string)[], side?: 'left' | 'right'): Caret =>
  ({ kind: 'node', path: path as never, ...(side !== undefined ? { side } : {}) });

const seed = (root: unknown, caret?: Caret): EditingState => {
  const s = initSession({ v: 1, root: root as never });
  return caret === undefined ? s : { ...s, caret };
};
const envOf = (state: EditingState): Envelope => ({ v: 1, root: JSON.parse(j(state.root)) as never });
const envRoot = (root: unknown): Envelope => ({ v: 1, root: root as never });
const moved = (state: EditingState, dir: NavDir): Caret | null => resolveMove(envOf(state), state.caret, dir);
const envMoved = (root: unknown, caret: Caret, dir: NavDir): Caret | null => resolveMove(envRoot(root), caret, dir);

const MID_ROW = (structure: unknown): unknown => ({
  type: 'op', op: 'add', args: [sym('x'), structure, sym('y')],
});

describe('4b-1 — OA-flank-stations: mid-row edge stations exist, are restable, insertable, D5-reachable', () => {
  it('every structure kind owns valid flank stations in mid-row positions (frac/pow/root/sub/group/fn)', () => {
    const structures = [
      { type: 'frac', num: num(1), den: num(2) },
      { type: 'pow', base: sym('a'), exp: num(2) },
      { type: 'root', radicand: sym('a'), index: num(3) },
      { type: 'sub', base: 'b', sub: 'm' },
      { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
      { type: 'fn', name: 'sin', args: [sym('a'), sym('b')] },
    ];
    for (const structure of structures) {
      const env = envRoot(MID_ROW(structure));
      expect(caretResolvesIn(env, node([1], 'left'))).toBe(true); // OA-flank-stations
      expect(caretResolvesIn(env, node([1], 'right'))).toBe(true);
      expect(initSession(env as never).root).toBeTruthy(); // fromJSON-legal throughout
    }
  });

  it('← / → rest at both flanks in the glyph zones — the full mid-row walk stops once per visible spot', () => {
    const root = MID_ROW({ type: 'frac', num: num(1), den: num(2) });
    expect(envMoved(root, tok([0], 1), 'right')).toEqual(node([1], 'left')); // the left flank (M-11)
    expect(envMoved(root, node([1], 'left'), 'right')).toEqual(tok([1, 'num'], 0)); // S-042: → into the numerator
    expect(envMoved(root, node([1], 'left'), 'left')).toEqual(tok([0], 1)); // back over the glyph
    expect(envMoved(root, tok([1, 'den'], 1), 'right')).toEqual(node([1], 'right')); // the right flank (M-10)
    expect(envMoved(root, node([1], 'right'), 'right')).toEqual(tok([2], 0));
    expect(envMoved(root, node([1], 'right'), 'left')).toEqual(tok([1, 'num'], 1)); // S-094 re-entry
    expect(envMoved(root, node([1], 'left'), 'down')).toBe(null); // N6: vertical keys never leave a flank cursor-first
  });

  it('typing at the edge station inserts a node DIRECTLY ADJACENT (the pinned trees)', () => {
    // at the LEFT flank: the token pairs directly BEFORE the structure
    const leftFr = seed(MID_ROW({ type: 'frac', num: num(1), den: num(2) }), node([1], 'left'));
    const a = typeToken(leftFr, { t: 'leaf', node: sym('c') });
    expect(j(a.root)).toBe(j({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'op', op: 'multiply', args: [sym('c'), { type: 'frac', num: num(1), den: num(2) }], implicit: true }, sym('y')],
    }));
    expect(a.caret).toEqual(tok([1, 0], 1));
    const d = typeToken(leftFr, { t: 'leaf', node: num(7) });
    expect(d.caret).toEqual(tok([1, 0], 1));
    // an operator glyph: the template with a null LEFT cell (the structure rides as its right operand)
    const g = typeToken(leftFr, { t: 'operator', fn: 'multiply' });
    expect(j(g.root)).toBe(j({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'op', op: 'multiply', args: [null, { type: 'frac', num: num(1), den: num(2) }] }, sym('y')],
    }));
    expect(g.caret).toEqual(seam([1], 1));
    // a structure key: the structure fills the RIGHT slot, □ left slot, caret in it
    const s = typeToken(leftFr, { t: 'divide' });
    expect(j(s.root)).toBe(j({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'frac', num: null, den: { type: 'frac', num: num(1), den: num(2) } }, sym('y')],
    }));
    expect(s.caret).toEqual(slot([1], 'num'));
    // the T9 root forward-grab: the structure right of the caret goes under the radical
    const r = insertRoot(leftFr);
    expect(JSON.parse(j(r.root))).toEqual({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'root', radicand: { type: 'frac', num: num(1), den: num(2) } }, sym('y')],
    });
    expect(caretResolvesIn(envOf(r), r.caret)).toBe(true);
    // at the RIGHT flank: the token pairs directly AFTER (the structure's left content)
    const rightFr = seed(MID_ROW({ type: 'frac', num: num(1), den: num(2) }), node([1], 'right'));
    const b = typeToken(rightFr, { t: 'leaf', node: sym('c') });
    expect(j(b.root)).toBe(j({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'op', op: 'multiply', args: [{ type: 'frac', num: num(1), den: num(2) }, sym('c')], implicit: true }, sym('y')],
    }));
    expect(b.caret).toEqual(tok([1, 1], 1));
    const f = insertSubscript(rightFr);
    expect(j(f.root)).toBe(j({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'op', op: 'multiply', args: [{ type: 'frac', num: num(1), den: num(2) }, { type: 'sub', base: '', sub: '' }], implicit: true }, sym('y')],
    }));
  });

  it('D5 highlight fires from the RIGHT-edge station for every fenceless kind (the returned decision kind)', () => {
    const forKind = (structure: unknown) => decideBackspace(envRoot(MID_ROW(structure)), node([1], 'right')).kind;
    expect(forKind({ type: 'frac', num: num(1), den: num(2) })).toBe('highlight');
    expect(forKind({ type: 'pow', base: sym('a'), exp: num(2) })).toBe('highlight');
    expect(forKind({ type: 'root', radicand: sym('a') })).toBe('highlight');
    expect(forKind({ type: 'sub', base: 'b', sub: 'm' })).toBe('highlight');
    // and the confirming BS deletes the structure WITH content (the pending null stays)
    const root = MID_ROW({ type: 'frac', num: num(1), den: num(2) });
    const confirm = decideBackspace(envRoot(root), node([1], 'right'), { highlighted: [1] });
    expect(confirm.kind).toBe('delete-structure');
    let st = seed(root, node([1], 'right'));
    for (const op of confirm.ops) st = applyOp(st, op as never);
    expect(JSON.parse(j(st.root))).toEqual({ type: 'op', op: 'add', args: [sym('x'), null, sym('y')] });
    expect(caretResolvesIn(envOf(st), st.caret)).toBe(true);
  });

  it('BS at the LEFT-edge station takes the ordinary D2 glyph rules (OA-glyph-delete; the highlight never fires)', () => {
    const root = MID_ROW({ type: 'frac', num: num(1), den: num(2) });
    const d = decideBackspace(envRoot(root), node([1], 'left'));
    expect(d.kind).toBe('glyph'); // the + dies, the cells bond — never a highlight from the before side
    const sub = decideBackspace(envRoot(MID_ROW({ type: 'sub', base: 'b', sub: 'm' })), node([1], 'left'));
    expect(sub.kind).toBe('glyph');
  });

  it('the subscript flanks keep their walk: base/script edges rest in the glyph zones (OA-flank-stations names sub)', () => {
    const root = MID_ROW({ type: 'sub', base: 'b', sub: 'm' });
    expect(envMoved(root, tok([0], 1), 'right')).toEqual(node([1], 'left'));
    expect(envMoved(root, node([1], 'left'), 'right')).toEqual(tok([1], 0, 'base'));
    expect(envMoved(root, tok([1], 1, 'sub'), 'right')).toEqual(node([1], 'right'));
    expect(envMoved(root, node([1], 'right'), 'left')).toEqual(tok([1], 1, 'sub'));
  });
});


describe('4b-1 — OA-fence-flank: the owner\'s four examples, byte-pinned', () => {
  const theGroup = () => ({
    type: 'frac', num: num(1),
    den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
  });

  it('example 1: `1/(a+b|)` + Del → `1/(a+b|` — the closing paren removed, caret at the content end', () => {
    const d = decideDelete(envRoot(theGroup()), tok(['den', 'child', 1], 1));
    expect(d.kind).toBe('close-fence');
    let st = seed(theGroup(), tok(['den', 'child', 1], 1));
    for (const op of d.ops) st = applyOp(st, op as never);
    expect(JSON.parse(j(st.root))).toEqual({
      type: 'frac', num: num(1),
      den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, close: false },
    });
    expect(st.caret).toEqual(tok(['den', 'child', 1], 1)); // the caret stays at the content end
    // the unbalanced-but-legal error annotation: storable, refused at the structural gate
    expect(() => initSession({ v: 1, root: JSON.parse(j(st.root)) })).not.toThrow();
    expect(isEvaluable(st.root as never)).toBe(false);
  });

  it('example 2: `1/(a+b)|` + BS → `1/(a+b` — the outside station removes the close; the two spots collapse', () => {
    const st = seed(theGroup(), tok(['den', 'child', 1], 1));
    const flank = moved(st, 'right'); // → from the content end reaches the outside station
    expect(flank).toEqual(node(['den'], 'right'));
    const d = decideBackspace(envOf(st), flank!);
    expect(d.kind).toBe('close-fence');
    let after = st;
    for (const op of d.ops) after = applyOp(after, op as never);
    expect(JSON.parse(j(after.root))).toEqual({
      type: 'frac', num: num(1),
      den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, close: false },
    });
    expect(after.caret).toEqual(tok(['den', 'child', 1], 1)); // collapsed onto the content end
    expect(isEvaluable(after.root as never)).toBe(false);
  });

  it('example 3: `1/|(a+b)` + Del → removes the OPENING paren (content promotes, close becomes a fence token)', () => {
    const st = seed(theGroup());
    const leftFlank = { ...st, caret: node(['den'], 'left') as Caret };
    expect(caretResolvesIn(envOf(leftFlank), leftFlank.caret)).toBe(true); // the outside-left station exists
    const d = decideDelete(envOf(leftFlank), leftFlank.caret);
    expect(d.kind).toBe('open-fence');
    let after = st;
    for (const op of d.ops) after = applyOp(after, op as never);
    expect(JSON.parse(j(after.root))).toEqual({
      type: 'frac', num: num(1),
      den: {
        type: 'op', op: 'multiply',
        args: [
          { type: 'op', op: 'add', args: [sym('a'), sym('b')] },
          { type: 'fence', side: 'close' },
        ],
        implicit: true,
      },
    });
    expect(isEvaluable(after.root as never)).toBe(false);
  });

  it('example 4: BS at the left-of-`(` station = the ordinary left-consume rule — a no-op here (nothing to its left)', () => {
    const d = decideBackspace(envRoot(theGroup()), node(['den'], 'left'));
    expect(d.kind).toBe('noop');
    // mid-row the ordinary gap rules apply instead: the binding glyph dies
    const midRow = MID_ROW({ type: 'group', parens: 'always', child: sym('b') });
    const g = decideBackspace(envRoot(midRow), node([1], 'left'));
    expect(g.kind).toBe('glyph');
  });

  it('the mid-row fence flanks are reachable: `x + (a+b) + y` walks both outside stations', () => {
    const root = MID_ROW({ type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    expect(envMoved(root, tok([0], 1), 'right')).toEqual(node([1], 'left')); // left of the open paren
    expect(envMoved(root, node([1], 'left'), 'right')).toEqual(tok([1, 'child', 0], 0)); // → enters the content
    expect(envMoved(root, tok([1, 'child', 1], 1), 'right')).toEqual(node([1], 'right')); // the post-`)` station
    expect(envMoved(root, node([1], 'right'), 'left')).toEqual(tok([1, 'child', 1], 1)); // ← crosses back over `)`
  });
});

describe('4b-1 — the twin-elimination corollary (the nav-key corollary, OA-visual-trumps)', () => {
  /** The paint-spot key of a rest state — the overlay-anchor equivalence:
   *  whichever element/edge the caret div anchors at, two carets with the
   *  same key paint at the same spot (the corollary's "one visual spot"). */
  const paintKey = (c: Caret): string => {
    switch (c.kind) {
      case 'empty': return 'E';
      case 'token': return `T:${j(c.path)}:${c.index}:${c.label ?? ''}`;
      case 'slot': return `S:${j(c.path)}:${c.slot}`;
      case 'node': return `N:${j(c.path)}:${c.side ?? ''}`;
      case 'row': {
        const row = (c.path).reduce<unknown>((acc, step) => (acc as { [k: string]: unknown })[step as string], rowEnv.root);
        const args = ((row as { args?: unknown[] }).args ?? []) as unknown[];
        if (c.index < args.length) {
          const cell = args[c.index] as { type: string } | null;
          if (cell === null) return `V:${j(c.path)}:${c.index}`;
          const t = cell.type;
          if (t === 'num') return `T:${j([...c.path, c.index])}:0`;
          if (t === 'sym') return `T:${j([...c.path, c.index])}:0`;
          if (t === 'sub') return `T:${j([...c.path, c.index])}:0:base`;
          if (t === 'unit') return `T:${j([...c.path, c.index, 'value'])}:0`;
          return `N:${j([...c.path, c.index])}:left`;
        }
        if (args.length > 0) {
          const last = args[args.length - 1] as { type: string } | null;
          if (last === null) return `V:${j(c.path)}:${c.index}`;
          const t = last.type;
          if (t === 'num' || t === 'sym') {
            const len = t === 'num' ? String((last as { value: number }).value).length : (last as { name: string }).name.length;
            return `T:${j([...c.path, args.length - 1])}:${len}`;
          }
          if (t === 'sub') return `T:${j([...c.path, args.length - 1])}:${(last as { sub: string }).sub.length}:sub`;
          if (t === 'unit') return `T:${j([...c.path, args.length - 1])}:${(last as { unit: string }).unit.length}`;
          return `N:${j([...c.path, args.length - 1])}:right`;
        }
        return `R:${j(c.path)}:${c.index}`;
      }
    }
  };
  let rowEnv: Envelope;
  const battery: unknown[] = [
    MID_ROW({ type: 'frac', num: num(1), den: num(2) }),
    MID_ROW({ type: 'pow', base: sym('a'), exp: num(2) }),
    MID_ROW({ type: 'root', radicand: sym('a'), index: num(3) }),
    MID_ROW({ type: 'sub', base: 'b', sub: 'm' }),
    MID_ROW({ type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } }),
    MID_ROW({ type: 'fn', name: 'sin', args: [sym('a'), sym('b')] }),
    { type: 'op', op: 'add', args: [sym('abc'), sym('de')] },
    { type: 'op', op: 'subtract', args: [num(2), null, num(3)] },
    { type: 'op', op: 'multiply', args: [num(123), { type: 'op', op: 'multiply', args: [sym('a'), num(456)], implicit: true }], implicit: true },
    { type: 'op', op: 'multiply', args: [{ type: 'op', op: 'multiply', args: [num(5), sym('x')], implicit: true }, num(3)] }, // V-16
    { type: 'op', op: 'multiply', args: [num(1), num(2)], implicit: true }, // V-17
    { type: 'frac', num: sym('q'), den: { type: 'op', op: 'add', args: [sym('a'), { type: 'frac', num: num(1), den: num(2) }] } }, // M-13
    { type: 'frac', num: num(1), den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } } }, // M-12
    { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('a'), mroot: true }] }, // M-18
    { type: 'op', op: 'add', args: [sym('a'), { type: 'unit', value: num(50), unit: 'mm' }, sym('b')] }, // I-19 mid-row
    { type: 'op', op: 'add', args: [sym('x'), { type: 'unit', value: num(50), unit: 'mm' }] },
  ];
  for (const root of battery) {
    const env = rowEnv = envRoot(root);
    for (const dir of ['right', 'left'] as NavDir[]) {
      it(`full ${dir} walk: one press = one visible movement, no spot rests twice (${j(root).slice(0, 40)}…)`, () => {
        // walk to the walk's start (← from the initSession seed)
        let s2 = seed(root);
        for (let i = 0; i < 40; i += 1) {
          const target = resolveMove(env, s2.caret, 'left');
          if (target === null || j(target) === j(s2.caret)) break;
          s2 = { ...s2, caret: target };
        }
        const walk: string[] = [];
        let cur: Caret | null = s2.caret;
        for (let i = 0; i < 60 && cur !== null; i += 1) {
          expect(caretResolvesIn(env, cur)).toBe(true);
          const key = paintKey(cur);
          if (walk.length > 0 && walk[walk.length - 1] === key) {
            expect.fail(`paints in place at ${key}: ${j(cur)} (root ${j(root)})`);
          }
          if (walk.includes(key)) {
            expect.fail(`rests twice at ${key}: ${j(cur)} (root ${j(root)})`);
          }
          walk.push(key);
          const target = resolveMove(env, cur, dir);
          if (target === null || j(target) === j(cur)) break; // the N3 end / defined no-op
          cur = target;
        }
        expect(walk.length).toBeGreaterThan(0);
      });
    }
  }

  it('named pin: the T-11 twin is gone — ← out of a lone power\'s base start is the N3 no-op (never a second state left of a)', () => {
    const root = { type: 'pow', base: sym('ab'), exp: num(2) };
    expect(envMoved(root, tok(['base'], 0), 'left')).toBe(null); // N3 — NO second rest left of a; the op clamps the no-op (OA-visual-trumps, the T-11 twin)
    const fracRoot = { type: 'frac', num: num(1), den: num(2) };
    expect(envMoved(fracRoot, tok(['num'], 0), 'left')).toEqual(node([], 'left')); // the frac keeps its before-station (M-08)
  });

  it('named pin: the eliminated glyphBond/glyphSplice seams — BS results rest at colonial canonical states, never the twin seam', () => {
    // `ab+|c` → the pair: dogfood cluster 2026-11-11 re-pin (rec-mwcmhuyq-2,
    // supersedes B-33 (2)'s left-edge landing) — the caret rests at the gap's
    // RIGHT edge (c's offset 0)
    const d = decideBackspace(envRoot({ type: 'op', op: 'add', args: [sym('ab'), sym('c')] }), seam([], 1));
    expect(d.caret).toEqual(tok([1], 0));
    // `x + |y` — never produced: the seam twins y@0 and a → press from it would paint in place
    const env = envRoot({ type: 'op', op: 'add', args: [sym('x'), sym('y')] });
    const twin = seam([], 1);
    expect(j(resolveMove(env, twin, 'right'))).not.toBe(j(twin));
  });
});

describe('4b-1 — OA-index-horizontal: the mroot index joins the horizontal step-through', () => {
  it('the EMPTY mroot index is reachable by ←/→ AND ↑/↓ (the □ is real geography)', () => {
    const root = { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('a'), mroot: true }] };
    expect(envMoved(root, tok([1, 'radicand'], 0), 'left')).toEqual(slot([1], 'index')); // ← into the □ index
    expect(envMoved(root, slot([1], 'index'), 'right')).toEqual(tok([1, 'radicand'], 0)); // → back into the radicand
    expect(envMoved(root, slot([1], 'index'), 'left')).toEqual(node([1], 'left')); // the root's left flank (T-9 OA-root-grab spine)
    // mid-row the radicand end exits to the root's R-flank (the glyph zone)
    const midRoot = { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('a'), mroot: true }, sym('y')] };
    expect(envMoved(midRoot, tok([1, 'radicand'], 1), 'right')).toEqual(node([1], 'right'));
    // a filled index participates the same way (OA-index-horizontal)
    const filled = { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('a'), index: num(3) }] };
    expect(envMoved(filled, tok([1, 'radicand'], 0), 'left')).toEqual(tok([1, 'index'], 1));
  });
});

describe('4b-1 — I-19/20/21: the trapped-carets probes, pinned', () => {
  it('I-19: OA-unit-single-seam — the value/label boundary is ONE walk stop; the whole unit stays walkable', () => {
    const walk = (r: unknown, start: Caret, dir: NavDir): Caret | null => envMoved(r, start, dir);
    const bare = { type: 'unit', value: num(50), unit: 'mm' };
    // OA-unit-single-seam: the seam is the label's offset 0; ← from it steps to the value's last INTERIOR offset (the value's end stop merged into the seam — no double step)
    expect(walk(bare, tok([], 0), 'left')).toEqual(tok(['value'], 1));
    expect(walk(bare, tok(['value'], 1), 'right')).toEqual(tok([], 0)); // → crosses into the label at the seam
    expect(walk(bare, tok(['value'], 2), 'right')).toEqual(tok([], 1)); // the value end (the seam's twin) skips past the seam to label@1 — no press rests on the seam twice
    expect(walk(bare, tok([], 2), 'right')).toBe(null); // N3 at the right end
    expect(walk(bare, tok(['value'], 0), 'left')).toBe(null); // N3 at the left end
    const midRow = { type: 'op', op: 'add', args: [sym('a'), { type: 'unit', value: num(50), unit: 'mm' }, sym('b')] };
    expect(walk(midRow, tok([1], 0), 'left')).toEqual(tok([1, 'value'], 1)); // OA-unit-single-seam
    expect(walk(midRow, tok([1, 'value'], 2), 'left')).toEqual(tok([1, 'value'], 1));
    expect(walk(midRow, tok([1], 2), 'right')).toEqual(tok([2], 0)); // out of the unit
    // the settle transitions keep the label offset (the conversion never traps)
    let s = initSession();
    for (const t of ['5', '0', 'm', 'm']) s = typeToken(s, KEY(t));
    const settled = settleUnits(s);
    expect(settled.caret).toEqual(tok([], 2));
    expect(caretResolvesIn(envOf(settled), settled.caret)).toBe(true);
  });

  it('I-20: after the root forward-grab every key moves (the square-root walk), and the mroot index is addressable', () => {
    const s = insertRoot(seed(num(123), tok([], 1)));
    for (const dir of ['left', 'right'] as NavDir[]) {
      const target = resolveMove(envOf(s), s.caret, dir);
      expect(target === null || j(target) === j(s.caret)).toBe(false); // ← and → both leave the grabbed radicand
    }
    const m = insertRoot(seed(num(123), tok([], 1)), { mroot: true });
    expect(m.caret).toEqual(tok([1, 'radicand'], 0));
    const up = resolveMove(envOf(m), m.caret, 'up'); // ↑ reaches the empty index slot
    expect(j(up)).toBe(j(slot([1], 'index')));
  });

  it('I-21: after a subscript insertion every direction is defined (movement, typing, and no trap)', () => {
    const bare = insertSubscript(seed(sym('x'), tok([], 1)));
    expect(bare.caret).toEqual(tok([], 0, 'sub'));
    expect(envMoved(symlessSub(), bare.caret, 'left')).toEqual(tok([], 1, 'base'));
    expect(envMoved(symlessSub(), { kind: 'token', path: [], index: 0, label: 'sub' }, 'right')).toBe(null); // N3 at the lone sub's right end
    expect(envRoot(symlessSub()).root).toBeTruthy();
    const mid = insertSubscript(seed(
      { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
      tok([0], 1),
    ));
    // mid-row after conversion: the empty script's → exits to the y cell (via the R-flank rule the walk stays one-press-per-spot)
    const t = resolveMove(envOf(mid), mid.caret, 'right');
    expect(j(t)).toBe(j(node([0], 'right')));
    const t2 = resolveMove(envOf(mid), t!, 'right');
    expect(j(t2)).toBe(j(tok([1], 0)));
  });
});

const KEY = (ch: string): { t: 'leaf'; node: unknown } =>
  ch === '5' || ch === '0' ? { t: 'leaf', node: num(Number(ch)) } : { t: 'leaf', node: sym(ch) };

function symlessSub(): unknown {
  return { type: 'sub', base: 'x', sub: '' };
}

describe('4b-1 — M-04: D5 from the after-power station highlights THE POWER ONLY', () => {
  it('engine level: x + a^2 — the bare-root right row-end keeps the seam; the highlight targets the pow\'s cell', () => {
    const root = { type: 'op', op: 'add', args: [sym('x'), { type: 'pow', base: sym('a'), exp: num(2) }] };
    const d = decideBackspace(envRoot(root), seam([], 2));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([1]); // the pow cell — never the root over-element
    const confirm = decideBackspace(envRoot(root), seam([], 2), { highlighted: [1] });
    let st = seed(root, seam([], 2));
    for (const op of confirm.ops) st = applyOp(st, op as never);
    expect(j(st.root)).toBe(j({ type: 'op', op: 'add', args: [sym('x'), null] })); // ONLY the pow dies (M-04)
  });

  it('a bare pow at the root: the after-station highlights the power (the whole formula IS the power)', () => {
    const root = { type: 'pow', base: sym('a'), exp: num(2) };
    const d = decideBackspace(envRoot(root), node([], 'right'));
    expect(d.kind).toBe('highlight');
    expect(d.target).toEqual([]);
  });
});
