// @vitest-environment jsdom
// Consolidated cleanup session (2026-11-10) — the DOM/overlay halves of the
// banked fix list: OA-glyph-click-halves, the K-08 background-snap fix, the
// interior-seam / after-structure paint rules, and OA-undo-burst through the
// real keyboard path. Every pin names its rule ID at the site.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromJSON, type Envelope } from '../src/ast/index.js';
import { caretResolvesIn, type Caret, type Path } from '../src/engine/index.js';
import { caretFromHit, hitFromMouseEvent, type ClickHit } from '../src/editor/click.js';
import { AFTER_STRUCTURE_SHIFT_PX, caretAnchor, seamAnchorSpec } from '../src/editor/caret-overlay.js';
import { isTypingToken, KEYMAP } from '../src/editor/keys.js';
import { EditorController } from '../src/editor/controller.js';
import { buildMathML, pathKey, type RenderedMath } from '../src/editor/mathml-dom.js';
import { stubRects, type Rect, type RectStub } from './editor-support.js';

afterEach(() => vi.restoreAllMocks());

const j = (x: unknown): string => JSON.stringify(x);
const sym = (name: string) => ({ type: 'sym', name }) as const;
const num = (value: number) => ({ type: 'num', value }) as const;
const row = (index: number, path: Path = []): Caret => ({ kind: 'row', path, index });
const node = (path: Path, side?: 'left' | 'right'): Caret => ({ kind: 'node', path, ...(side ? { side } : {}) });
const tok = (path: Path, index: number): Caret => ({ kind: 'token', path, index });

interface Fixture {
  controller: EditorController;
  container: HTMLDivElement;
  stub: RectStub;
  rendered: RenderedMath;
  el: (path: string) => Element;
  sep: (i: number) => Element;
}

function fixture(envelope: unknown, byPath: Record<string, Rect>, byCaret: Record<string, Caret> = {}): Fixture {
  const container = document.createElement('div');
  container.id = 'cleanup';
  document.body.appendChild(container);
  const stub = stubRects({ cleanup: { left: 100, top: 50, width: 400, height: 40 } });
  stub.setMath({ left: 100, top: 50, width: 400, height: 40 });
  const controller = new EditorController(container, { envelope });
  const rendered = controller.getRendered()!;
  stub.syncPath(rendered, byPath);
  for (const [k, r] of Object.entries(byCaret)) {
    const el = rendered.placeholderByCaret.get(k);
    if (el) stub.set(el, r);
  }
  controller.updateCaret();
  return {
    controller,
    container,
    stub,
    rendered,
    el: (path: string) => rendered.elementByPath.get(path)!,
    sep: (i: number) => [...rendered.separators.keys()][i],
  };
}

const clickF = (el: Element, f: number): void => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + f * r.width }));
};
const click = (el: Element, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX }));
};
const press = (container: HTMLElement, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void => {
  container.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift }),
  );
};

// x + 1/2 + y: row [0,60); x [0,10); sep+ [10,15); mfrac [15,45); sep+ [45,50); y [50,60)
const MID_FRAC = { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(12), den: num(34) }, sym('y')] } };
const MID_FRAC_LAYOUT: Record<string, Rect> = {
  '[]': { left: 0, top: 0, width: 60, height: 20 },
  '[0]': { left: 0, top: 0, width: 10, height: 10 },
  '[1]': { left: 15, top: 0, width: 30, height: 20 },
  '[2]': { left: 50, top: 0, width: 10, height: 10 },
};
const midFrac = (): Fixture => {
  const f = fixture(MID_FRAC, MID_FRAC_LAYOUT);
  f.stub.set(f.sep(0), { left: 10, top: 5, width: 5, height: 10 });
  f.stub.set(f.sep(1), { left: 45, top: 5, width: 5, height: 10 });
  return f;
};

// x + sin(a) + y: row [0,60); x [0,10); sep [10,15); fn mrow [15,50); head [15,22); open [22,26); arg a [26,36); close [36,40); sep [45,50); y [50,60)
const MID_FN = { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fn', name: 'sin', args: [sym('a')] }, sym('y')] } };
const MID_FN_LAYOUT: Record<string, Rect> = {
  '[]': { left: 0, top: 0, width: 60, height: 10 },
  '[0]': { left: 0, top: 0, width: 10, height: 10 },
  '[1]': { left: 15, top: 0, width: 35, height: 10 },
  '[1,0]': { left: 26, top: 0, width: 10, height: 10 },
  '[2]': { left: 50, top: 0, width: 10, height: 10 },
};
const midFn = (): Fixture => {
  const f = fixture(MID_FN, MID_FN_LAYOUT);
  f.stub.set(f.sep(0), { left: 10, top: 0, width: 5, height: 10 });
  f.stub.set(f.sep(1), { left: 45, top: 0, width: 5, height: 10 });
  return f;
};

describe('cleanup — OA-glyph-click-halves (ruled 2026-11-10): left half of an operator glyph → before the glyph; right half keeps the shared gap', () => {
  it('pure resolver: separator hit halves', () => {
    const env = MID_FRAC as unknown as Envelope;
    // right half (>= 0.5): today’s behind-the-glyph shared gap
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 1, fraction: 0.5 })).toEqual(row(1));
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 1, fraction: 0.9 })).toEqual(row(1));
    // left half (< 0.5): the position BEFORE the glyph — the left cell’s right edge (x’s in-token end)
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 1, fraction: 0.2 })).toEqual(tok([0], 1));
    // the second glyph’s left half: before it is the FRACTION’s right flank (a mid-row structure edge)
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 2, fraction: 0.2 })).toEqual(node([1], 'right'));
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 2, fraction: 0.8 })).toEqual(row(2));
    // the unary lead glyph (index 0) has no left cell: always the seam
    const unEnv: Envelope = { v: 1, root: { type: 'op', op: 'unaryMinus', args: [sym('x')] } };
    expect(caretFromHit(unEnv, { kind: 'separator', path: [], index: 0, fraction: 0.1 })).toEqual(row(0));
  });

  it('the before-glyph positions are existing restable+insertable states (no new caret kind)', () => {
    const env = MID_FRAC as unknown as Envelope;
    for (const c of [tok([0], 1), node([1], 'right')]) {
      expect(caretResolvesIn(env, c)).toBe(true); // OA-glyph-click-halves — additive station extension only
    }
  });

  it('through the real click path: clicking the left half of the first `+` lands before it; the right half keeps the gap', () => {
    const f = midFrac();
    f.container.focus();
    clickF(f.sep(0), 0.2); // left half of the `+`
    expect(f.controller.getState().caret).toEqual(tok([0], 1)); // OA-glyph-click-halves: before the glyph = x’s in-token end
    // re-grab the separator from the CURRENT render after any rebuild
    const sepNow = () => [...f.controller.getRendered()!.separators.keys()][0];
    clickF(sepNow(), 0.8); // right half
    expect(f.controller.getState().caret).toEqual(row(1)); // the shared gap behind the glyph (N2 corollary)
    clickF(sepNow(), 0.2);
    expect(f.controller.getState().caret).toEqual(tok([0], 1));
  });
});

describe('cleanup — K-08 fix (4b-2 (v)): a background click near a glyph snaps to the NEAREST element, not the formula-wide 50/50 split', () => {
  it('clicking the background just left of sin in x + sin(a) + y resolves at the fn’s left zone — typing inserts before the fn', () => {
    const f = midFn();
    f.container.focus();
    const math = f.rendered.math;
    f.stub.setMath({ left: 0, top: 0, width: 60, height: 10 });
    click(math, 14); // in the `+` glyph’s span [10,15) — just left of the fn
    expect(f.controller.getState().caret).toEqual(row(1)); // the shared gap before the fn (the sep’s right half) — NOT the formula start (K-08)
    press(f.container, 'q');
    // the letter glues into the left-adjacent symbol at the gap (the standing N2 seam rule) — the caret
    // was at the gap before the fn, and typing behaves from there (previously the click landed at row [] #0)
    expect(j(f.controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [{ type: 'sym', name: 'xq' }, { type: 'fn', name: 'sin', args: [sym('a')] }, sym('y')] }),
    );
    expect(f.controller.getState().caret).toEqual(row(1)); // the seam survives the glue (directly after the grown token’s gap)
    // re-sync the stubbed rects onto the rebuilt render (and re-grab the math
    // element — the rebuild replaceChild’d it), then click the fn’s left edge zone
    f.stub.syncPath(f.controller.getRendered()!, MID_FN_LAYOUT);
    f.stub.setMath({ left: 0, top: 0, width: 60, height: 10 });
    click(f.controller.getRendered()!.math, 16); // inside the fn mrow’s left edge zone
    expect(f.controller.getState().caret).toEqual(node([1], 'left')); // the head’s left-edge zone → the flank
  });

  it('the pure none-hit keeps the canonical border stations (row-start twin collapsed) and the middle dive', () => {
    const env = MID_FN as unknown as Envelope;
    expect(caretFromHit(env, { kind: 'none', fraction: 0.04 })).toEqual(tok([0], 0)); // the canonical start (rowEndStation), not the raw row([],0) twin
    expect(caretFromHit(env, { kind: 'none', fraction: 0.96 })).toEqual(tok([2], 1)); // the canonical end
    expect(caretFromHit(env, { kind: 'none', fraction: 0.5 })).toEqual(tok([2], 1)); // middle-right: enter-from-side dive
  });
});

describe('cleanup — paint rules: K-07/M-15 #5 interior seam anchors at the separator glyph; OA-after-structure-shift on the after-station', () => {
  it('seamAnchorSpec: an interior row seam with a glyph on its left anchors at the separator (never the following cell’s extent)', () => {
    const env = MID_FRAC as unknown as Envelope;
    expect(seamAnchorSpec(env, row(1))).toEqual({ kind: 'separator', rowPath: [], index: 1 }); // K-07 / 4b-2 amendment
    expect(seamAnchorSpec(env, row(2))).toEqual({ kind: 'separator', rowPath: [], index: 2 }); // M-15 #5
    expect(seamAnchorSpec(env, row(0))).toEqual({ kind: 'element', path: [0] }); // the row start keeps the current element
    expect(seamAnchorSpec(env, row(3))).toEqual({ kind: 'element', path: [2] }); // the end seam rides the last cell
  });

  it('caretAnchor: the interior seam paints at the glyph’s right edge with the glyph’s height (not the fraction’s full height)', () => {
    const f = midFrac();
    const env = MID_FRAC as unknown as Envelope;
    const a = caretAnchor(env, row(1), f.rendered)!;
    expect(a.x).toBe(15); // the `+` glyph’s right edge (M-15 #5 — not the mfrac’s left edge at 15... the glyph edge wins)
    expect(a.height).toBe(10); // the glyph’s text height — not the fraction’s 20 (K-07)
    expect(a.y).toBe(5);
    // the row start keeps the current element’s extent
    const a0 = caretAnchor(env, row(0), f.rendered)!;
    expect(a0.x).toBe(0);
    expect(a0.height).toBe(10); // x’s height
  });

  it('caretAnchor: the after-structure station paints with the small right shift (OA-after-structure-shift, M-18)', () => {
    const f = midFrac();
    const env = MID_FRAC as unknown as Envelope;
    const a = caretAnchor(env, node([1], 'right'), f.rendered)!;
    expect(a.x).toBe(45 + AFTER_STRUCTURE_SHIFT_PX); // the mfrac extent’s right edge + the ruled shift
    expect(a.height).toBe(20); // the structure’s own full height (the right flank rides the structure)
    // the radicand-end vs after-structure pair at a root (M-18’s shape) shares the x — the shift separates them
    const m18 = { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: sym('a'), mroot: true } as never] } };
    const g = fixture(m18, { '[]': { left: 0, top: 0, width: 40, height: 20 }, '[0]': { left: 0, top: 0, width: 10, height: 10 }, '[1]': { left: 15, top: 0, width: 25, height: 20 } });
    const env18 = m18 as unknown as Envelope;
    const after = caretAnchor(env18, node([1], 'right'), g.rendered)!;
    expect(after.x).toBe(40 + AFTER_STRUCTURE_SHIFT_PX);
  });
});

describe('cleanup — OA-undo-burst (ruled 2026-11-10): every operator press is its own undo unit', () => {
  it('isTypingToken drops the operator class; leaves/dot/space/comma/parens stay', () => {
    expect(isTypingToken({ t: 'operator', fn: 'add' })).toBe(false); // OA-undo-burst
    expect(isTypingToken({ t: 'operator', fn: 'multiply' })).toBe(false);
    expect(isTypingToken({ t: 'leaf', node: sym('a') })).toBe(true);
    expect(isTypingToken({ t: 'leaf', node: num(1) })).toBe(true);
    expect(isTypingToken({ t: 'dot' })).toBe(true);
    expect(isTypingToken({ t: 'space' })).toBe(true);
    expect(isTypingToken({ t: 'comma' })).toBe(true);
    expect(isTypingToken({ t: 'groupOpen' })).toBe(true);
    expect(isTypingToken({ t: 'groupClose' })).toBe(true);
    expect(isTypingToken({ t: 'divide' })).toBe(false); // structure key: own unit (as before)
    expect(isTypingToken({ t: 'pow' })).toBe(false);
  });

  it('through the keyboard path: `a++b` is FOUR units ([a],[+],[+],[b]) — consecutive operators never coalesce', () => {
    const f = fixture({ v: 1, root: null }, {});
    f.container.focus();
    for (const ch of ['a', '+', '+', 'b']) press(f.container, ch);
    expect(f.controller.getState().log.map((e) => e.ops.length)).toEqual([1, 1, 1, 1]); // OA-undo-burst
    // `a++b` types literally: the same-op row extends flat — add[a, null, b] (T1)
    expect(j(f.controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('a'), null, sym('b')] }),
    );
    // undo walks unit-by-unit: the b run, the second +, the first +, the a run
    const walk: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      press(f.container, 'z', { ctrl: true });
      walk.push(j([f.controller.getEnvelope().root, f.controller.getState().caret]));
    }
    expect(walk[0]).toBe(j([{ type: 'op', op: 'add', args: [sym('a'), null, null] }, row(2)])); // the b run undone
    expect(walk[1]).toBe(j([{ type: 'op', op: 'add', args: [sym('a'), null] }, row(1)])); // the second `+` undone
    expect(walk[2]).toBe(j([sym('a'), tok([], 1)])); // the first `+` undone
    expect(walk[3]).toBe(j([null, { kind: 'empty' }])); // the a run undone
  });

  it('`50mm` + `+` keeps the [4,1,1] trace (the settle unit + the operator unit) — OA-undo-burst re-pin', () => {
    const f = fixture({ v: 1, root: null }, {});
    f.container.focus();
    for (const ch of ['5', '0', 'm', 'm']) press(f.container, ch);
    press(f.container, '+');
    expect(f.controller.getState().log.map((e) => e.ops.length)).toEqual([4, 1, 1]); // [50mm run], [settle], [+]
    expect(j(f.controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [{ type: 'unit', value: num(50), unit: 'mm' }, null] }),
    );
  });
});

describe('cleanup — hitFromMouseEvent carries the separator fraction (OA-glyph-click-halves plumbing)', () => {
  it('a raw separator event maps to a separator hit WITH the click fraction', () => {
    const f = midFrac();
    const rendered = buildMathML(fromJSON(MID_FRAC), document);
    f.stub.syncPath(rendered, MID_FRAC_LAYOUT);
    f.stub.set([...rendered.separators.keys()][0], { left: 10, top: 5, width: 5, height: 10 });
    const sep = [...rendered.separators.keys()][0];
    const ev = { target: sep, clientX: 11 } as unknown as MouseEvent;
    const hit = hitFromMouseEvent(ev, rendered) as Extract<ClickHit, { kind: 'separator' }>;
    expect(hit.kind).toBe('separator');
    expect(hit.index).toBe(1);
    expect(hit.fraction).toBeCloseTo(0.2); // (11-10)/5
    // and the resolver maps the left half to before-the-glyph
    expect(caretFromHit(MID_FRAC as unknown as Envelope, hit)).toEqual(tok([0], 1));
  });
});
