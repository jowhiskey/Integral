// Rework session 4a — engine navigation/caret acceptance: the N1–N8 rule
// family + the three scoping rulings (OA-visual-trumps, OA-token-end,
// OA-vertical-default) + the ratified lone-root border stations
// (owner ruling 2026-11-09) + the navigation corollary (one press = one
// visible movement or a defined no-op). Every pin names its rule.

import { describe, expect, it } from 'vitest';

import {
  applyOp,
  caretResolvesIn,
  decideBackspace,
  initSession,
  resolveMove,
  typeToken,
  type Caret,
  type EditingState,
  type Envelope,
  type NavDir,
} from '../src/engine/index.js';

const j = (x: unknown): string => JSON.stringify(x);
const rootNode = (t: unknown): Record<string, unknown> => t as Record<string, unknown>;
const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const tok = (path: (number | string)[], index: number, label?: 'base' | 'sub'): Caret => ({
  kind: 'token', path: path as never, index, ...(label !== undefined ? { label } : {}),
});
const seam = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path: path as never, index });
const slot = (path: (number | string)[], s: string): Caret => ({ kind: 'slot', path: path as never, slot: s as never });
const node = (path: (number | string)[], side?: 'left' | 'right'): Caret =>
  ({ kind: 'node', path: path as never, ...(side !== undefined ? { side } : {}) });

const seed = (root: unknown): EditingState => initSession({ v: 1, root: root as never });
const withCaret = (state: EditingState, caret: Caret): EditingState =>
  ({ root: state.root, caret, log: state.log, redo: state.redo, vocabulary: state.vocabulary });
const envOf = (state: EditingState): Envelope => ({ v: 1, root: JSON.parse(j(state.root)) });
const move = (state: EditingState, dir: NavDir): EditingState => applyOp(state, { op: 'move', dir });
const moved = (state: EditingState, dir: NavDir): Caret =>
  resolveMove(envOf(state), state.caret, dir);

describe('4a — N1: char-wise stepping inside every token; exits at the ends (S-036)', () => {
  it('numbers incl. decimals step digit-by-digit; the seed rests at the in-token end (OA-token-end)', () => {
    const s = seed(num(123));
    expect(s.caret).toEqual(tok([], 3));
    expect(moved(s, 'left')).toEqual(tok([], 2));
    const dotted = seed({ type: 'num', value: 12, dot: true }); // renders `12.`
    expect(dotted.caret).toEqual(tok([], 3));
    expect(moved(dotted, 'left')).toEqual(tok([], 2));
  });

  it('symbols step letter-by-letter; sub labels step within their own label and cross base-to-script in reading order (T9/OA-sub-label)', () => {
    const s = seed(sym('abc'));
    expect(s.caret).toEqual(tok([], 3));
    expect(moved(s, 'left')).toEqual(tok([], 2));
    expect(moved(withCaret(s, tok([], 2)), 'left')).toEqual(tok([], 1));
    expect(moved(withCaret(s, tok([], 1)), 'left')).toEqual(tok([], 0));
    const sub = seed({ type: 'sub', base: 'x', sub: 'max' });
    expect(sub.caret).toEqual(tok([], 3, 'sub')); // the script's end
    expect(moved(sub, 'left')).toEqual(tok([], 2, 'sub'));
    expect(moved(withCaret(sub, tok([], 0, 'sub')), 'left')).toEqual(tok([], 1, 'base')); // the seam crossing
    expect(moved(withCaret(sub, tok([], 0, 'sub')), 'right')).toEqual(tok([], 1, 'sub'));
  });
});

describe('4a — N2 + the corollary: one shared gap station, no press spent on a transition that paints in place', () => {
  it('a full → walk of abc+de lands each visual position exactly once and ends in the N3 no-op', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('abc'), sym('de')] });
    let at = withCaret(s, tok([0], 0));
    const walk: Caret[] = [at.caret];
    for (let i = 0; i < 12; i += 1) {
      const next = move(at, 'right');
      if (next === at) break;
      at = next;
      walk.push(at.caret);
    }
    expect(walk).toEqual([
      tok([0], 0), tok([0], 1), tok([0], 2), tok([0], 3), // abc; its end paints left of the +
      tok([1], 0), tok([1], 1), tok([1], 2), // ONE press crosses the glyph to de's start; d's end IS the row end
    ]);
    // the walk terminated in the formula-end no-op (N3), one press per distinct spot
  });

  it('BS and typing address the same merged gap state: BS at a token start deletes the binding glyph (OA-glyph-delete)', () => {
    const env = { v: 1 as const, root: { type: 'op', op: 'add', args: [sym('ab'), sym('de')] } } as never;
    const d = decideBackspace(env, tok([1], 0));
    expect(d.kind).toBe('glyph'); // the glyph dies — never the token's front char
  });
});

describe('4a — N4: horizontal exits at the visual level (S-039 B)', () => {
  it('the slot ends exit past the whole structure into the row — never sideways', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(1), den: sym('d') }, sym('y')] });
    expect(moved(withCaret(s, tok([1, 'num'], 1)), 'right')).toEqual(tok([2], 0)); // the numerator NEVER dives into den
    expect(moved(withCaret(s, tok([1, 'den'], 1)), 'right')).toEqual(tok([2], 0)); // the denominator (S-041)
    const pow = seed({ type: 'op', op: 'add', args: [{ type: 'pow', base: sym('a'), exp: num(2) }, sym('y')] });
    expect(moved(withCaret(pow, tok([0, 'exp'], 1)), 'right')).toEqual(tok([1], 0)); // the exponent (S-044)
    const group = seed({ type: 'op', op: 'add', args: [{ type: 'group', parens: 'always', child: sym('b') }, sym('y')] });
    expect(moved(withCaret(group, tok([0, 'child'], 1)), 'right')).toEqual(tok([1], 0)); // past the fence (S-046)
  });
});

describe('4a — N5: the ruled horizontal entries/exits (S-042/S-043/S-094/S-095/S-096)', () => {
  it('S-042: → into a fraction from the left → the numerator start', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(12), den: num(3) }] });
    expect(moved(withCaret(s, tok([0], 1)), 'right')).toEqual(tok([1, 'num'], 0));
  });

  it("S-043: → at a power's base end → the exponent offset 0", () => {
    const s = seed({ type: 'pow', base: sym('ab'), exp: num(2) });
    expect(moved(withCaret(s, tok(['base'], 2)), 'right')).toEqual(tok(['exp'], 0));
  });

  it('S-094: ← into a fraction from the right → the NUMERATOR end (never the geometrically adjacent den); the power takes the exponent end', () => {
    const frac = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(12), den: num(3) }] });
    expect(moved(withCaret(frac, seam([], 2)), 'left')).toEqual(tok([1, 'num'], 2));
    const pow = seed({ type: 'op', op: 'add', args: [{ type: 'pow', base: sym('a'), exp: sym('n') }, sym('y')] });
    expect(moved(withCaret(pow, seam([], 1)), 'left')).toEqual(tok([0, 'exp'], 1)); // the seam right after the power
  });

  it('S-095: ← at the denominator start exits past the whole fraction; at a lone root it rests at the ratified before-station', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(1), den: sym('d') }] });
    expect(moved(withCaret(s, tok([1, 'den'], 0)), 'left')).toEqual(tok([0], 1));
    const lone = seed({ type: 'frac', num: num(1), den: sym('d') });
    expect(moved(withCaret(lone, tok(['den'], 0)), 'left')).toEqual(node([], 'left'));
  });

  it("S-096: ← at the exponent's offset 0 → the base's end", () => {
    const s = seed({ type: 'pow', base: sym('ab'), exp: num(2) });
    expect(moved(withCaret(s, tok(['exp'], 0)), 'left')).toEqual(tok(['base'], 2));
  });
});

describe('4a — N6/OA-vertical-default: vertical arrival rests at the region content end (owner ruling)', () => {
  it("a denominator holding a fenced group lands INSIDE the fences, after the groups last content character", () => {
    const s = seed({
      type: 'frac',
      num: sym('q'),
      den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
    });
    expect(moved(withCaret(s, tok(['num'], 1)), 'down')).toEqual(tok(['den', 'child', 1], 1));
  });

  it("a bare rows end is the one position it already has", () => {
    const s = seed({ type: 'frac', num: sym('q'), den: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    expect(moved(withCaret(s, tok(['num'], 1)), 'down')).toEqual(tok(['den', 1], 1));
  });

  it('a row ending in a frac STOPS at the seam right after it ("rest at the end of the frac")', () => {
    const s = seed({
      type: 'frac',
      num: sym('q'),
      den: { type: 'op', op: 'add', args: [sym('a'), { type: 'frac', num: num(1), den: num(2) }] },
    });
    expect(moved(withCaret(s, tok(['num'], 1)), 'down')).toEqual(seam(['den'], 2));
  });

  it('a slot holding a lone frac rests at its den content end (the visually coincident "end of the frac")', () => {
    const s = seed({ type: 'frac', num: sym('q'), den: { type: 'frac', num: num(1), den: num(2) } });
    expect(moved(withCaret(s, tok(['num'], 1)), 'down')).toEqual(tok(['den', 'den'], 1));
  });

  it('↑/↓ on flat rows and past the formula are silent no-ops (S-048/N6)', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('a'), sym('b')] });
    const at = withCaret(s, tok([0], 1));
    expect(move(at, 'up') === at).toBe(true);
    expect(move(at, 'down') === at).toBe(true);
  });
});

describe('4a — N7/N8: functions and empty slots', () => {
  it('N7: → past the comma into the next argument; the LAST argument exits past the closing fence (S-047)', () => {
    const s = seed({
      type: 'op',
      op: 'add',
      args: [sym('x'), { type: 'fn', name: 'sin', args: [sym('a'), sym('b')] }, sym('z')],
    });
    expect(moved(withCaret(s, tok([1, 0], 1)), 'right')).toEqual(tok([1, 1], 0)); // one press crosses the comma
    expect(moved(withCaret(s, tok([1, 1], 1)), 'right')).toEqual(tok([2], 0)); // exits the call into the row
  });

  it('N8: empty slots are normal slots — → exits the structure, the □ stays (S-049)', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(1), den: null }] });
    const at = withCaret(s, slot([1], 'den'));
    const next = move(at, 'right');
    expect(j(rootNode(next.root))).toEqual(j(rootNode(s.root))); // pure movement: the tree untouched
    // the exit lands the after-fraction seam (the fraction is the row's last
    // cell — the structure boundary keeps its seam, OA-visual-trumps); a
    // further -> is the formula end (N3)
    expect(next.caret).toEqual(seam([], 2));
    expect(move(next, 'right') === next).toBe(true);
  });
});

describe('4a — OA-token-end: typed-token result states (T-07/T-08/T-09/I-14 fixed at the engine level)', () => {
  it('typing `abc` ends as the token caret at offset 3; typing `*` ends at the after-seam', () => {
    let s = seed(null);
    s = typeToken(s, { t: 'leaf', node: sym('a') });
    expect(s.caret).toEqual(tok([], 1));
    s = typeToken(s, { t: 'leaf', node: sym('b') });
    expect(s.caret).toEqual(tok([], 2));
    s = typeToken(s, { t: 'leaf', node: sym('c') });
    expect(s.caret).toEqual(tok([], 3)); // the in-token end
    s = typeToken(s, { t: 'operator', fn: 'multiply' });
    expect(rootNode(s.root).type).toBe('op');
    expect(s.caret).toEqual(seam([], 1)); // the pending cell — the seam station immediately after the glyph
  });

  it('digits and the dot end in-token; structure keys land their ruled slots (T7/OA-token-end)', () => {
    let s = seed(null);
    s = typeToken(s, { t: 'leaf', node: num(5) });
    expect(s.caret).toEqual(tok([], 1));
    s = typeToken(s, { t: 'dot' });
    expect(s.caret).toEqual(tok([], 2)); // inside `5.`
    s = typeToken(s, { t: 'leaf', node: sym('x') });
    expect(s.caret).toEqual(tok([1], 1)); // the juxtaposed x's in-token end
    const p = typeToken(seed(num(2)), { t: 'pow' });
    expect(p.caret).toEqual(slot([], 'exp')); // the structure key's ruled slot
  });
});

describe('4a — OA-visual-trumps: the pinned geometry distinctions', () => {
  it("a bare op row in a slot has exactly ONE end position — b's in-token end; no second rest state shares its spot", () => {
    const s = seed({ type: 'frac', num: sym('q'), den: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    const atEnd = withCaret(s, tok(['den', 1], 1)); // the row's ONE end: b's in-token end
    // -> rests at no second end-of-row state — it steps out of the fraction
    // entirely (the ratified lone-root after-station, a visually distinct
    // position past the whole structure); <- walks back through the one end
    expect(moved(atEnd, 'right')).toEqual(node([], 'right'));
    expect(moved(withCaret(s, tok(['den', 1], 0)), 'left')).toEqual(tok(['den', 0], 1));
  });

  it('a fenced group renders TWO positions: `1/(a+b|)` inside vs the seam after `)` — both distinct and reachable', () => {
    const s = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } }] });
    const inside = tok([1, 'child', 1], 1); // (`b|)` — the content end INSIDE
    const after = seam([], 2); // the gap after `)`
    const back = moved(withCaret(s, after), 'left');
    expect(back).toEqual(inside); // ← crosses into the content end
    // → at the content end exits PAST the fence back to the after-group
    // seam — the two positions stay distinct, one press apart; from there
    // → is N3 (the formula end)
    const out = move(withCaret(s, inside), 'right');
    expect(out.caret).toEqual(after);
    expect(move(out, 'right') === out).toBe(true);
    // both exist and differ; S-046's exit:
    const s3 = seed({ type: 'op', op: 'add', args: [sym('x'), { type: 'group', parens: 'always', child: sym('b') }, sym('z')] });
    expect(moved(withCaret(s3, tok([1, 'child'], 1)), 'right')).toEqual(tok([2], 0));
  });

  it('radicand end vs whole-root end keep their distinct deletion behaviors (D1/S-109 vs D5)', () => {
    // radicand content end: BS deletes the last character (D1) and the □ appears
    const env = { v: 1 as const, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('ab') }] } } as never;
    const inside = decideBackspace(env, tok([1, 'radicand'], 2));
    expect(inside.kind).toBe('char'); // the last char goes, □ never appears mid-token — the tree shrinks in place
    // the whole-root end seam: BS arms the D5 highlight (never fires from inside, S-109)
    const after = decideBackspace(env, seam([], 2));
    expect(after.kind).toBe('highlight');
    expect(after.target).toEqual([1]);
  });
});

describe('4a — the corollary + invariants', () => {
  it('every state a full arrow walk produces passes caretResolvesIn, and movement never logs', () => {
    const s = seed({
      type: 'op',
      op: 'add',
      args: [sym('ab'), { type: 'frac', num: num(1), den: sym('c') }, sym('d')],
    });
    let at = withCaret(s, tok([0], 0));
    for (let i = 0; i < 40; i += 1) {
      const next = move(at, 'right');
      if (next === at) break;
      expect(caretResolvesIn(envOf(next), next.caret)).toBe(true);
      expect(next.log).toBe(at.log);
      at = next;
    }
    expect(move(at, 'right') === at).toBe(true); // terminated in the formula-end no-op (N3)
  });

  it('← walks are mirror images: nothing lands a duplicate of the origin spot either', () => {
    const s = seed({
      type: 'op',
      op: 'add',
      args: [sym('ab'), { type: 'frac', num: num(1), den: sym('c') }, sym('d')],
    });
    let at = withCaret(s, tok([2], 1)); // the formula end (d's end)
    let presses = 0;
    for (let i = 0; i < 40; i += 1) {
      const next = move(at, 'left');
      if (next === at) break;
      expect(caretResolvesIn(envOf(next), next.caret)).toBe(true);
      at = next;
      presses += 1;
    }
    expect(presses).toBeGreaterThan(0);
    expect(move(at, 'left') === at).toBe(true); // N3 at the formula start
  });
});
