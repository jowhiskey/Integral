// OA-seam-family (owner ruling 2026-11-11): the implicit-seam family — how the
// @vitest-environment jsdom
// editor handles the glyph-less juxtaposition gap between two cells of an
// implicit-multiply row. The gap bifurcates on the EXISTING implicitPairLegal
// predicate: a LEGAL pair (num|group before non-num) is ONE caret station at
// the gap (the `50|mm` unit pattern generalized), rendered glyph-less with
// plain spacing, no marker; an ILLEGAL split (num-num S-098, sym-before-X,
// fn/unit-before-X) keeps BOTH edge stations and renders the wide red
// `.integral-seam` carrier. The typed key decides the channel at the legal
// seam; an operator at either station resolves the gap; the illegal gap is a
// deletable object (merge table + guard). Every pin names the clause.

import { describe, expect, it } from 'vitest';

import { fromJSON, toMathML, type Envelope, type NodeJson } from '../src/ast/index.js';
import { buildMathML } from '../src/editor/mathml-dom.js';
import { caretFromHit, type ClickHit } from '../src/editor/click.js';
import { shape } from './editor-support.js';
import {
  backspace,
  decideBackspace,
  decideDelete,
  envelopeOf,
  forwardDelete,
  initSession,
  resolveMove,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type NavDir,
} from '../src/engine/index.js';

const j = (x: unknown): string => JSON.stringify(x);
const num = (value: number, dot = false): NodeJson =>
  (dot ? { type: 'num', value, dot: true } : { type: 'num', value }) as NodeJson;
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const op = (o: string, ...args: (unknown | null)[]) => ({ type: 'op', op: o, args }) as NodeJson;
const imp = (...args: (unknown | null)[]) =>
  ({ type: 'op', op: 'multiply', args, implicit: true }) as NodeJson;
const group = (child: unknown): NodeJson => ({ type: 'group', parens: 'always', child }) as NodeJson;
const frac = (n: unknown, d: unknown): NodeJson => ({ type: 'frac', num: n, den: d });
const rootN = (radicand: unknown): NodeJson => ({ type: 'root', radicand }) as NodeJson;
const fn = (name: string, args: unknown[]): NodeJson => ({ type: 'fn', name, args });
const unit = (value: unknown, u: string): NodeJson => ({ type: 'unit', value, unit: u });

const rowc = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path: path as never, index });
const tok = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path: path as never, index });
const envRoot = (root: unknown): Envelope => ({ v: 1, root: root as never });
const at = (root: unknown, caret: Caret): EditingState => ({ ...initSession({ v: 1, root: root as never }), caret });
const envMoved = (root: unknown, caret: Caret, dir: NavDir): Caret | null => resolveMove(envRoot(root), caret, dir);
const mathOf = (root: unknown): string => toMathML(fromJSON(envRoot(root))!);

const SEAM = '<mspace class="integral-seam" width="0.5em" height="0.75em" depth="0.2em" style="background:#c62828"/>';

const d = (ch: string): { t: 'leaf'; node: NodeJson } => ({ t: 'leaf', node: num(Number(ch)) });
const s = (ch: string): { t: 'leaf'; node: NodeJson } => ({ t: 'leaf', node: sym(ch) });
const plus = { t: 'operator', fn: 'add' } as const;
const space = { t: 'space' } as const;

const tokenLen = (node: unknown): number => {
  const n = node as { type: string; value?: number; dot?: boolean; name?: string; unit?: string };
  if (n.type === 'num') return (String(n.value) + (n.dot === true ? '.' : '')).length;
  if (n.type === 'sym') return (n.name ?? '').length;
  if (n.type === 'unit') return (n.unit ?? '').length; // the label is the addressed text (S-104)
  return 0;
};
const firstOf = (pair: NodeJson): unknown => (pair as { args: unknown[] }).args[0];
const lastOf = (pair: NodeJson): unknown => {
  const a = (pair as { args: unknown[] }).args;
  return a[a.length - 1];
};
// the gap's two edge stations: BS fires at the right-edge station, Del at the
// left-edge station (OA-seam-family (6)). Token cells (num/sym/unit) use
// in-token carets; containers use the row seam / node flank.
const rightEdge = (r: unknown): Caret =>
  tokenLen(r) > 0 ? tok([1], 0) : rowc([], 1);
const leftEdge = (l: unknown): Caret =>
  tokenLen(l) > 0 ? tok([0], tokenLen(l)) : ({ kind: 'node', path: [0], side: 'right' } as Caret);

// ——— (1) a legal pair is ONE station at the gap ———

describe('OA-seam-family (1): the legal pair gap is one walk stop (the 50|mm pattern generalized)', () => {
  it('`5x`: → from the number’s interior end lands ON the seam (x@0); → from the number’s END (the twin) crosses the whole gap in ONE step; ← likewise; both sides resolve to the same station', () => {
    const fiveX = imp(num(5), sym('x'));
    expect(envMoved(fiveX, tok([0], 0), 'right')).toEqual(tok([1], 0)); // the seam — the number’s end is skipped
    expect(envMoved(fiveX, tok([0], 1), 'right')).toEqual(tok([1], 1)); // the twin skips past the seam: one step across the gap
    expect(envMoved(fiveX, tok([1], 1), 'left')).toEqual(tok([1], 0)); // the seam, from the right side — the SAME station
    expect(envMoved(fiveX, tok([1], 0), 'left')).toEqual(tok([0], 0)); // ← from the seam crosses the gap in one step (into the number, not its end twin)
    expect(envMoved(fiveX, tok([1], 1), 'right')).toEqual(tok([1], 1)); // N3: resolveMove returns the same state (the null clamp lives in applyMove)
    // a longer number: 50·mmx — the I-22 (b) acceptance walk (logger case)
    const pair = imp(num(50), sym('mmx'));
    expect(envMoved(pair, tok([1], 3), 'left')).toEqual(tok([1], 2));
    expect(envMoved(pair, tok([1], 2), 'left')).toEqual(tok([1], 1));
    expect(envMoved(pair, tok([1], 1), 'left')).toEqual(tok([1], 0)); // the ONE gap stop
    expect(envMoved(pair, tok([1], 0), 'left')).toEqual(tok([0], 1)); // one step across the gap into the number (not the twin num@2)
    expect(envMoved(pair, tok([0], 1), 'right')).toEqual(tok([1], 0)); // → back onto the seam
    expect(envMoved(pair, tok([0], 2), 'right')).toEqual(tok([1], 1)); // the number’s end (twin) skips past the seam
  });

  it('`5(a+b)` / `5√2` (container right cell): the seam is the row gap; one stop, then the dive', () => {
    const g = imp(num(5), group(op('add', sym('a'), sym('b'))));
    expect(envMoved(g, tok([0], 0), 'right')).toEqual(rowc([], 1)); // the seam
    expect(envMoved(g, rowc([], 1), 'right')).toEqual(tok([1, 'child', 0], 0)); // then the dive into the group
    expect(envMoved(g, tok([1, 'child', 0], 0), 'left')).toEqual(rowc([], 1)); // ← back to the seam (one step)
    expect(envMoved(g, rowc([], 1), 'left')).toEqual(tok([0], 0)); // ← from the seam into the number (twin skipped)
    expect(envMoved(g, tok([0], 1), 'right')).toEqual(tok([1, 'child', 0], 0)); // the number’s end (twin) crosses the gap in one step
    const r = imp(num(5), rootN(num(2)));
    expect(envMoved(r, tok([0], 0), 'right')).toEqual(rowc([], 1));
    expect(envMoved(r, rowc([], 1), 'right')).toEqual(tok([1, 'radicand'], 0));
  });

  it('an implicit subrow nested in an explicit row (V-16 shape) gets the same single seam', () => {
    const v16 = op('multiply', imp(num(5), sym('x')), num(3));
    expect(envMoved(v16, tok([0, 0], 0), 'right')).toEqual(tok([0, 1], 0)); // the subrow’s seam
    expect(envMoved(v16, tok([0, 1], 0), 'left')).toEqual(tok([0, 0], 0)); // back across the gap in one step
    expect(envMoved(v16, tok([0, 1], 1), 'right')).toEqual(tok([1], 0)); // out of the subrow over the × glyph
  });

  it('group-before-X (also legal) keeps its single seam at x@0', () => {
    const g = imp(group(sym('a')), sym('x'));
    expect(envMoved(g, tok([0, 'child'], 1), 'right')).toEqual(tok([1], 0)); // group content end → the seam (one step)
    expect(envMoved(g, tok([1], 0), 'left')).toEqual(tok([0, 'child'], 1)); // ← from the seam back to the group’s right edge
  });
});

// ——— (1)/(2) rendering: legal = no marker; illegal = wide red carrier ———

describe('OA-seam-family (1)/(2) rendering: bifurcation on implicitPairLegal, both renderers byte-parallel', () => {
  it('legal pairs render glyph-less with plain spacing — NO .integral-seam in either renderer', () => {
    for (const root of [
      imp(num(5), sym('x')),
      imp(num(5), group(op('add', sym('a'), sym('b')))),
      imp(num(5), rootN(num(2))),
      imp(num(5), frac(sym('a'), num(2))),
      imp(group(sym('a')), sym('x')),
    ]) {
      expect(mathOf(root)).not.toContain('integral-seam');
      const built = buildMathML(fromJSON(envRoot(root))!, document);
      expect(built.seamGaps.size).toBe(0);
      expect(built.math.querySelector('.integral-seam')).toBeNull();
    }
    // byte-pin one legal pair (unchanged from before the ruling)
    expect(mathOf(imp(num(5), sym('x')))).toBe('<math><mrow><mn>5</mn><mi>x</mi></mrow></math>');
  });

  it('illegal splits render the wide red carrier in BOTH renderers (parity: same tag, same attrs)', () => {
    const illegal = [
      imp(num(5), num(3)), // S-098 num-num
      imp(sym('x'), num(3)), // sym-before-X
      imp(sym('x'), group(sym('a'))), // sym|group
      imp(fn('sin', [num(1)]), sym('x')), // fn-before-X
      imp(unit(num(5), 'mm'), sym('x')), // unit-before-X
      imp(group(sym('a')), num(2)), // group|num
    ];
    for (const root of illegal) {
      expect(mathOf(root)).toContain(SEAM);
      const built = buildMathML(fromJSON(envRoot(root))!, document);
      expect(built.seamGaps.size).toBe(1);
      const el = built.math.querySelector('.integral-seam')!;
      expect(el.getAttribute('width')).toBe('0.5em'); // visibly wide: the two edge stations are two spots
      expect(el.getAttribute('height')).toBe('0.75em');
      expect(el.getAttribute('depth')).toBe('0.2em');
      expect(el.getAttribute('style')).toBe('background:#c62828'); // red: an error state at a glance
      // parity with the string renderer (tags+text)
      const parsed = new DOMParser().parseFromString(mathOf(root), 'text/html').body.firstElementChild!;
      expect(shape(built.math)).toBe(shape(parsed));
    }
  });
});

// ——— (2) the typed key decides the channel at the legal seam ———

describe('OA-seam-family (2): key-decides-channel at the legal seam (both edge twins redirect to the row seam)', () => {
  it('digit/`.` → the number side; letter → the non-num side (glue into the symbol); operator → an ordinary glyph insert between', () => {
    const fiveX = imp(num(5), sym('x'));
    // digit at the seam (x@0): extends the LEFT number — `5x` + 7 → 57x
    let st = typeToken(at(fiveX, tok([1], 0)), d('7'));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(57), sym('x'))));
    // digit at the left twin (5’s end) — the same channel
    st = typeToken(at(fiveX, tok([0], 1)), d('7'));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(57), sym('x'))));
    // dot at the seam → the number’s decimal point
    st = typeToken(at(fiveX, tok([1], 0)), { t: 'dot' });
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5, true), sym('x'))));
    // letter at the seam → glues into the symbol (the non-num side)
    st = typeToken(at(fiveX, tok([1], 0)), s('y'));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), sym('yx'))));
    expect(st.caret).toEqual(tok([1], 1));
    // operator at the seam → the ordinary T1 insert binding the sides into an explicit row; the gap state is gone
    st = typeToken(at(fiveX, tok([1], 0)), plus);
    expect(j(envelopeOf(st).root)).toBe(j(op('add', num(5), sym('x'))));
    expect(mathOf(envelopeOf(st).root)).not.toContain('integral-seam');
    st = typeToken(at(fiveX, tok([0], 1)), plus);
    expect(j(envelopeOf(st).root)).toBe(j(op('add', num(5), sym('x'))));
  });

  it('letter at a legal num-before-group seam seeds a new symbol before the structure', () => {
    const g = imp(num(5), group(sym('a')));
    const st = typeToken(at(g, rowc([], 1)), s('z')); // the row-gap seam
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), imp(sym('z'), group(sym('a'))))));
    // digit at the same seam goes to the number side
    const st2 = typeToken(at(g, rowc([], 1)), d('7'));
    expect(j(envelopeOf(st2).root)).toBe(j(imp(num(57), group(sym('a')))));
  });
});

// ——— (4) illegal splits keep BOTH edge stations (each reachable, distinct) ———

describe('OA-seam-family (2): the illegal split keeps the two edge stations — a distinct state each', () => {
  it('`5 5` (S-098): the walk rests at BOTH edges of the wide gap (num@1 then num2@0)', () => {
    const nn = imp(num(1), num(2)); // V-17
    expect(envMoved(nn, tok([0], 0), 'right')).toEqual(tok([0], 1)); // the left edge station
    expect(envMoved(nn, tok([0], 1), 'right')).toEqual(tok([1], 0)); // the right edge station — two distinct stops
    expect(envMoved(nn, tok([1], 0), 'left')).toEqual(tok([0], 1));
    expect(envMoved(nn, tok([1], 1), 'right')).toEqual(tok([1], 1)); // N3: same-state return
    // sym-before-X too
    const xn = imp(sym('x'), num(3));
    expect(envMoved(xn, tok([0], 1), 'right')).toEqual(tok([1], 0));
    expect(envMoved(xn, tok([1], 0), 'left')).toEqual(tok([0], 1));
  });

  it('gap clicks map to the single seam station (legal) or the two edge stations (illegal)', () => {
    const legal = imp(num(5), sym('x'));
    const hit = (index: number, fraction: number): ClickHit => ({ kind: 'seamGap', path: [], index, fraction });
    expect(caretFromHit(envRoot(legal), hit(1, 0.25))).toEqual(tok([1], 0)); // legal: ONE station, either half
    expect(caretFromHit(envRoot(legal), hit(1, 0.75))).toEqual(tok([1], 0));
    const illegal = imp(num(5), num(3));
    expect(caretFromHit(envRoot(illegal), hit(1, 0.25))).toEqual(tok([0], 1)); // left half → the left edge
    expect(caretFromHit(envRoot(illegal), hit(1, 0.75))).toEqual(tok([1], 0)); // right half → the right edge
  });
});

// ——— (5) an operator at EITHER station resolves the gap (never blocks input) ———

describe('OA-seam-family (5): typing an operator at either station binds the sides — the gap state is gone', () => {
  it('`5 5` + `+` → `5+5` (legal explicit row, marker gone) — from the left edge, the right edge, and the row gap', () => {
    const nn = imp(num(5), num(5));
    for (const caret of [tok([0], 1), tok([1], 0), rowc([], 1)]) {
      const st = typeToken(at(nn, caret), plus);
      expect(j(envelopeOf(st).root)).toBe(j(op('add', num(5), num(5))));
      expect(mathOf(envelopeOf(st).root)).toBe('<math><mrow><mn>5</mn><mo>+</mo><mn>5</mn></mrow></math>');
    }
    // the legal pair’s seam + operator → the explicit row too (pinned in (2) as well)
    const st = typeToken(at(imp(num(5), sym('x')), rowc([], 1)), plus);
    expect(j(envelopeOf(st).root)).toBe(j(op('add', num(5), sym('x'))));
  });
});

// ——— (6) the illegal gap is a deletable object: the merge table + splice caret + one undo unit ———

describe('OA-seam-family (6): gap deletion per the merge table (BS at the right-edge station / Del at the left-edge station)', () => {
  it('(num,num) → digit concatenation into ONE number, caret at the splice offset; one op = one undo unit (undo byte-restores)', () => {
    const cases: [NodeJson, NodeJson, NodeJson, number][] = [
      [num(5), num(5), num(55), 1], // `5 5` → `55`
      [num(5), num(0.5), num(50.5), 1], // `5`+`0.5` → `50.5`
      [num(5, true), num(5), num(5.5), 2], // `5.`+`5` → `5.5`
      [num(5), num(5, true), num(55, true), 1], // `5`+`5.` → `55.` (splice after the left `5`)
    ];
    for (const [l, r, merged, off] of cases) {
      const pair = imp(l, r);
      const st = backspace(at(pair, tok([1], 0))); // BS at the right-edge station
      expect(j(envelopeOf(st).root)).toBe(j(merged));
      expect(st.caret).toEqual(tok([], off)); // the splice offset inside the merged token
      expect(st.log.length).toBe(1);
      const undone = undo(st);
      expect(j(envelopeOf(undone).root)).toBe(j(pair)); // byte-exact restore
      expect(undone.caret).toEqual(tok([1], 0));
      // BS at the row gap and Del at the left-edge station are the same deletion
      expect(j(envelopeOf(backspace(at(pair, rowc([], 1)))).root)).toBe(j(merged));
      expect(j(envelopeOf(forwardDelete(at(pair, tok([0], tokenLen(l))))).root)).toBe(j(merged));
    }
  });

  it('(sym,num) → digit-glue into the name; (sym,sym) → letter glue', () => {
    let st = backspace(at(imp(sym('x'), num(5)), tok([1], 0))); // `x 5` → `x5`
    expect(j(envelopeOf(st).root)).toBe(j(sym('x5')));
    expect(st.caret).toEqual(tok([], 1));
    st = backspace(at(imp(sym('x'), sym('y')), tok([1], 0))); // `x y` → `xy`
    expect(j(envelopeOf(st).root)).toBe(j(sym('xy')));
    expect(st.caret).toEqual(tok([], 1));
    st = forwardDelete(at(imp(sym('ab'), sym('cd')), tok([0], 2))); // Del at the left edge
    expect(j(envelopeOf(st).root)).toBe(j(sym('abcd')));
    expect(st.caret).toEqual(tok([], 2));
  });

  it('glyph-glyph → the adjacent-glyph row state (`+ *` → `+*`, the S-001 typing shape)', () => {
    const pair = imp(op('add', null, null), op('multiply', null, null));
    const st = backspace(at(pair, rowc([], 1)));
    expect(j(envelopeOf(st).root)).toBe(j(op('add', null, op('multiply', null, null))));
    expect(st.caret).toEqual(rowc([], 1)); // the splice seam inside the merged row
  });

  it('the outward directions keep ordinary character deletion; the LEGAL single seam keeps the D2/D1 adjacent-char mirror (NO gap deletion)', () => {
    // illegal pair, BS at the LEFT edge: the left number’s last char goes (ordinary)
    let st = backspace(at(imp(num(5), num(5)), tok([0], 1)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(null, num(5))));
    // illegal pair, Del at the RIGHT edge: the right number’s first char goes (ordinary)
    st = forwardDelete(at(imp(num(5), num(5)), tok([1], 0)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), null)));
    // LEGAL pair `5x`: BS at the seam peels the LEFT char, Del at the left edge removes the RIGHT char — the tree stands as the pair, no merge
    st = backspace(at(imp(num(5), sym('x')), tok([1], 0)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(null, sym('x'))));
    st = forwardDelete(at(imp(num(5), sym('x')), tok([0], 1)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), null)));
  });

  it('a 3-cell implicit row merges only the gap’s two cells (the other gaps stand)', () => {
    // `5 x 5` split shape: [5, x, 5] — the legal gap (5,x) and the illegal gap (x,5)
    const three = imp(num(5), sym('x'), num(5));
    const st = backspace(at(three, tok([2], 0))); // BS at the right-edge station of the (x,5) gap
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), sym('x5')))); // x glues the 5
    expect(st.caret).toEqual(tok([1], 1)); // splice offset inside the merged name
  });
});

// ——— (7) the merge guard: the refusal classes are silent no-ops; the split/merge round trip ———

describe('OA-seam-family (6) merge guard: refusal classes are silent no-ops (the red gap is undeletable there)', () => {
  it('(a) both sides decimal; (b) symbol + decimal number; (c) no fusion and no legal multiply', () => {
    const refusals = [
      imp(num(5.5), num(0.5)), // (a) "5.50.5" is not a number
      imp(sym('x'), num(0.5)), // (b) the dot cannot join a name
      imp(sym('x'), group(sym('a'))), // (c) sym|group
      imp(sym('x'), frac(sym('a'), num(2))), // (c) sym|structure
      imp(fn('sin', [num(1)]), sym('x')), // (c) fn|X
      imp(unit(num(5), 'mm'), sym('x')), // (c) unit|X
      imp(group(sym('a')), num(2)), // (c) group|num
    ];
    for (const pair of refusals) {
      const bsAt = rightEdge(lastOf(pair));
      const delAt = leftEdge(firstOf(pair));
      const before = at(pair, bsAt);
      const dd = decideBackspace(envRoot(pair), bsAt);
      expect(dd.kind).toBe('noop'); // silent no-op — never a left-consume, never a merge
      const st = backspace(before);
      expect(st).toBe(before); // the same state object, nothing logged
      expect(decideDelete(envRoot(pair), delAt).kind).toBe('noop'); // Del at the left edge too
    }
  });

  it('the round trip: `50.5` split by Space into `5`+`0.5` merges back EXACTLY to `50.5`', () => {
    // Space inside the number at offset 1
    const split = typeToken(at(num(50.5), tok([], 1)), space);
    expect(j(envelopeOf(split).root)).toBe(j(imp(num(5), num(0.5))));
    expect(split.caret).toEqual(rowc([], 1)); // the Space-created gap landing
    const merged = backspace(split); // BS at the gap
    expect(j(envelopeOf(merged).root)).toBe(j(num(50.5)));
    expect(merged.caret).toEqual(tok([], 1)); // the splice offset (after the `5`)
    expect(merged.log.length).toBe(2); // the split + the merge = two units; one undo steps back to the split
    expect(j(envelopeOf(undo(merged)).root)).toBe(j(imp(num(5), num(0.5))));
  });
});

// ——— (4) Space parity: a Space-created gap and a directly-typed juxtaposition are the same stored state ———

describe('OA-seam-family (4): Space-split and typed juxtapositions get identical stations and rendering', () => {
  it('`5` Space `5` and `55` Space@1 produce the same envelope, the same wide red marker, and the same edge stations', () => {
    // producer A: type 5, Space, 5 (the boundary flag forces the second number node)
    let a = at(num(5), tok([], 1));
    a = typeToken(a, space);
    a = typeToken(a, d('5'));
    // producer B: type 55, Space inside at offset 1
    const b = typeToken(at(num(55), tok([], 1)), space);
    expect(j(envelopeOf(a).root)).toBe(j(envelopeOf(b).root)); // the same stored state
    expect(j(envelopeOf(a).root)).toBe(j(imp(num(5), num(5))));
    expect(mathOf(envelopeOf(a).root)).toBe(mathOf(envelopeOf(b).root));
    expect(mathOf(envelopeOf(a).root)).toContain(SEAM); // the wide red gap (S-021’s no-visible-mark clause superseded)
    // the same seam treatment: from the Space-split landing (row#1 ≡ the right
    // edge station, dogfood rec-mwcmu8sa-8) ← reaches the left edge, → skips the
    // twin and reaches the second number's end
    expect(envMoved(envelopeOf(b).root, rowc([], 1), 'left')).toEqual(tok([0], 1));
    expect(envMoved(envelopeOf(b).root, rowc([], 1), 'right')).toEqual(tok([1], 1));
    // and the gap is deletable from that landing: BS → `55`
    const merged = backspace(b);
    expect(j(envelopeOf(merged).root)).toBe(j(num(55)));
    expect(merged.caret).toEqual(tok([], 1));
    // DOM parity for the Space-created state too
    const built = buildMathML(fromJSON(envRoot(envelopeOf(b).root))!, document);
    expect(built.seamGaps.size).toBe(1);
  });
});

// ——— (3) the unit→symbol conversion resolves by construction (the pair is legal → the single seam) ———

describe('OA-seam-family (3): the unit→symbol conversion double seam resolves by construction', () => {
  it('`50mm|` + `x` → the legal pair 50·mmx with ONE seam station (the unit’s own seam is unchanged)', () => {
    const st = typeToken(at(unit(num(50), 'mm'), tok([], 2)), s('x')); // letter at the label end reverts the run, appending to the name
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(50), sym('mmx'))));
    // the post-conversion pair is legal → one stop at the gap
    expect(envMoved(envelopeOf(st).root, tok([1], 3), 'left')).toEqual(tok([1], 2));
    expect(envMoved(envelopeOf(st).root, tok([1], 1), 'left')).toEqual(tok([1], 0)); // the seam
    expect(envMoved(envelopeOf(st).root, tok([1], 0), 'left')).toEqual(tok([0], 1)); // one step across into the number
    // no seam marker renders (legal pair)
    expect(mathOf(envelopeOf(st).root)).not.toContain('integral-seam');
  });
});

// ——— dogfood cluster 2026-11-11T21-35 (integral-testlog-cluster-2026-11-11T21-35-20-171Z.json, 9 recordings) ———
// Each pin cites its rec- id. The recorded comments are the owner's rulings.

describe('dogfood cluster 2026-11-11: seam landings + walk twins (rec- ids cited)', () => {
  it('rec-mwcm8ovm-0 / rec-mwcmjcwr-3 / rec-mwcmw6mq-9: BS emptying the right cell of an implicit pair lands at the LEFT cell’s right edge ("after the 5" / "after the a"), not the row seam', () => {
    let st = backspace(at(imp(num(5), sym('ab')), tok([1], 2)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), sym('a'))));
    expect(st.caret).toEqual(tok([1], 1));
    st = backspace(st);
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), null)));
    expect(st.caret).toEqual(tok([0], 1)); // after the 5
    st = backspace(at(imp(sym('a'), sym('a')), tok([1], 1)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(sym('a'), null)));
    expect(st.caret).toEqual(tok([0], 1)); // right edge of the left "a"
    st = backspace(at(imp(sym('a'), sym('b')), tok([1], 1)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(sym('a'), null)));
    expect(st.caret).toEqual(tok([0], 1));
    expect(backspace(st).caret).toEqual({ kind: 'empty' });
  });

  it('rec-mwcmb8ok-1: → from the left edge of an illegal gap with a container right cell rests at the gap’s RIGHT edge (the row seam, in front of `(`) — no dive', () => {
    const g = imp(sym('b'), group(op('add', sym('a'), sym('b'))));
    expect(envMoved(g, tok([0], 1), 'right')).toEqual(rowc([], 1)); // the right edge of the gap
    expect(envMoved(g, rowc([], 1), 'right')).toEqual(tok([1, 'child', 0], 0)); // then the dive
    expect(envMoved(g, tok([1, 'child', 0], 0), 'left')).toEqual(rowc([], 1)); // ← back out rests at the right edge too
    expect(envMoved(g, rowc([], 1), 'left')).toEqual(tok([0], 1)); // then the left edge
  });

  it('rec-mwcmhuyq-2: BS deleting the binding glyph bonds the pair with the caret at the gap’s RIGHT edge (not the left operand’s end)', () => {
    const st = backspace(at(op('add', num(5), num(5)), tok([1], 0)));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), num(5))));
    expect(st.caret).toEqual(tok([1], 0)); // the right edge of the wide gap
  });

  it('rec-mwcmu8sa-8: → from the row seam of an illegal pair with a token right cell skips the twin — ONE press reaches after b (no mechanical no-op)', () => {
    const st = typeToken(at(sym('ab'), tok([], 1)), space);
    expect(j(envelopeOf(st).root)).toBe(j(imp(sym('a'), sym('b'))));
    expect(st.caret).toEqual(rowc([], 1));
    expect(envMoved(envelopeOf(st).root, st.caret, 'right')).toEqual(tok([1], 1)); // one press, after b
    // the right-edge station is still reachable from the left edge, and back
    expect(envMoved(envelopeOf(st).root, tok([0], 1), 'right')).toEqual(tok([1], 0));
    expect(envMoved(envelopeOf(st).root, tok([1], 0), 'left')).toEqual(tok([0], 1));
    expect(envMoved(envelopeOf(st).root, rowc([], 1), 'left')).toEqual(tok([0], 1));
  });

  it('rec-mwcmzfd6-b: ← from the row end of an illegal pair lands at the last cell’s left edge ("left of the second 5") — not locked', () => {
    let st = typeToken(at(num(5), tok([], 1)), space);
    st = typeToken(st, d('5'));
    expect(j(envelopeOf(st).root)).toBe(j(imp(num(5), num(5))));
    expect(st.caret).toEqual(rowc([], 2));
    expect(envMoved(envelopeOf(st).root, st.caret, 'left')).toEqual(tok([1], 0));
  });

  it('rec-mwcmo3bd-6 / rec-mwcmq3pj-7: a structure key at either edge station of an illegal gap grabs BOTH cells across the gap (the pair collapses into the structure)', () => {
    // right-edge station: `/` at tok([1],0) — "a" lands in the numerator, caret at the denominator start
    let st = typeToken(at(imp(sym('a'), sym('b')), tok([1], 0)), { t: 'divide' });
    expect(j(envelopeOf(st).root)).toBe(j(frac(sym('a'), sym('b'))));
    expect(st.caret).toEqual(tok(['den'], 0));
    // left-edge station: `/` at tok([0],1) — "b" lands in the denominator, caret after "a" in the numerator
    st = typeToken(at(imp(sym('a'), sym('b')), tok([0], 1)), { t: 'divide' });
    expect(j(envelopeOf(st).root)).toBe(j(frac(sym('a'), sym('b'))));
    expect(st.caret).toEqual(tok(['num'], 1));
    // `^` rides the same structure-key path
    st = typeToken(at(imp(sym('a'), sym('b')), tok([0], 1)), { t: 'pow' });
    expect(j(envelopeOf(st).root)).toBe(j({ type: 'pow', base: sym('a'), exp: sym('b') }));
    expect(st.caret).toEqual(tok(['base'], 1));
  });
});
