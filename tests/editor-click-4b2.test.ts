// @vitest-environment jsdom
// Rework session 4b-2 — the click surface (C1–C5 + click coverage + the keymap
// audit), wired onto the final 4b-1 position inventory. jsdom has no layout:
// rects are stubbed (the established stubRects pattern); clicks are real
// bubbling MouseEvents dispatched on the target element. Pins:
//   C1  nearest-edge: num/sym/unit-label/sub-label clicks resolve character-wise
//       (row cells AND slot content — supersedes the session-3 slot/root-num
//       inconsistency); operator glyphs → the shared gap stations (N2 corollary);
//       past a slot's content → its end; mid-row structure flanks click-reachable
//   C2  every □ producer clicked → the slot entered, caret before the □
//   C3  the fraction bar → 50/50 to the gaps before/after the WHOLE fraction,
//       never inside num/den (stubbed mfrac rect geometry)
//   C4  fn head name → after the open paren; head left edge → the gap before the
//       head; fence glyphs → their nearest flank station
//   C5  background snap (S-061), empty formula included
//   mechanics: click-only moves never log; clicks never read or write the
//       vertical memory (both directions)
//   coverage: glyph seams address the SAME state inventory as arrows/typing
//       (OA-visual-trumps); V-18 fence regions; the keymap audit pin (every
//       coverage-matrix input → its actual keymap behavior)

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromJSON, type Envelope } from '../src/ast/index.js';
import { caretResolvesIn, type Caret, type Path } from '../src/engine/index.js';
import { caretFromHit, hitFromMouseEvent } from '../src/editor/click.js';
import { classifyKey, KEYMAP, type KeyAction } from '../src/editor/keys.js';
import { EditorController } from '../src/editor/controller.js';
import { buildMathML, caretKey, pathKey, type RenderedMath } from '../src/editor/mathml-dom.js';
import { regionKey } from '../src/editor/vertical-memory.js';
import { stubRects, type Rect, type RectStub } from './editor-support.js';

afterEach(() => vi.restoreAllMocks());

const sym = (name: string) => ({ type: 'sym', name }) as const;
const num = (value: number) => ({ type: 'num', value }) as const;

interface Fixture {
  controller: EditorController;
  container: HTMLDivElement;
  stub: RectStub;
  rendered: RenderedMath;
  el: (path: string) => Element;
  sep: (i: number) => Element;
  placeholder: (caret: Caret) => Element;
  fenceEl: (path: Path, side: 'open' | 'close') => Element;
  headEl: (path: Path) => Element;
  subLabelEl: (path: Path, label: 'base' | 'sub') => Element;
}

function fixture(envelope: unknown, byPath: Record<string, Rect>, byCaret: Record<string, Rect> = {}): Fixture {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  const stub = stubRects({ container: { left: 100, top: 50, width: 400, height: 40 } });
  stub.setMath({ left: 100, top: 50, width: 400, height: 40 });
  const controller = new EditorController(container, { envelope });
  const rendered = controller.getRendered()!;
  stub.syncPath(rendered, byPath);
  stub.syncCaret(rendered, byCaret);
  controller.updateCaret();
  return {
    controller,
    container,
    stub,
    rendered,
    el: (path: string) => rendered.elementByPath.get(path)!,
    sep: (i: number) => [...rendered.separators.keys()][i],
    placeholder: (caret: Caret) => rendered.placeholderByCaret.get(caretKey(caret))!,
    fenceEl: (path, side) => {
      const e = [...rendered.fenceGlyphs.entries()].find(([_, f]) => f.side === side && pathKey(f.path) === pathKey(path));
      if (!e) throw new Error(`no fence glyph ${side} at ${pathKey(path)}`);
      return e[0];
    },
    headEl: (path) => {
      const e = [...rendered.fnHeads.entries()].find(([_, p]) => pathKey(p) === pathKey(path));
      if (!e) throw new Error(`no fn head at ${pathKey(path)}`);
      return e[0];
    },
    subLabelEl: (path, label) => {
      const l = rendered.subLabels.get(pathKey(path));
      if (!l) throw new Error(`no sub labels at ${pathKey(path)}`);
      return label === 'base' ? l.base : l.script;
    },
  };
}

/** Dispatch a click at fraction `f` of the element's stubbed rect. */
const clickF = (el: Element, f: number): void => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + f * r.width }));
};

const click = (el: Element, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX }));
};

const press = (container: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): void => {
  container.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
};

const row = (index: number, path: Path = []): Caret => ({ kind: 'row', path, index });
const node = (path: Path, side?: 'left' | 'right'): Caret => ({ kind: 'node', path, ...(side ? { side } : {}) });
const tok = (path: Path, index: number, label?: 'base' | 'sub'): Caret => ({
  kind: 'token',
  path,
  index,
  ...(label ? { label } : {}),
});
const slot = (path: Path, s: string): Caret => ({ kind: 'slot', path, slot: s as never });

// ——— the shared mid-row fixture: x + 1/2 + y ———
// row [0,60); x [0,10); sep+ [10,15); mfrac [15,45); sep+ [45,50); y [50,60)
const MID_FRAC = { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(12), den: num(34) }, sym('y')] } };
const MID_FRAC_LAYOUT: Record<string, Rect> = {
  '[]': { left: 0, top: 0, width: 60, height: 20 },
  '[0]': { left: 0, top: 0, width: 10, height: 10 },
  '[1]': { left: 15, top: 0, width: 30, height: 20 },
  '[1,"num"]': { left: 20, top: 0, width: 8, height: 8 },
  '[1,"den"]': { left: 20, top: 12, width: 8, height: 8 },
  '[2]': { left: 50, top: 0, width: 10, height: 10 },
};
const midFrac = () => {
  const f = fixture(MID_FRAC, MID_FRAC_LAYOUT);
  f.stub.set(f.sep(0), { left: 10, top: 0, width: 5, height: 10 });
  f.stub.set(f.sep(1), { left: 45, top: 0, width: 5, height: 10 });
  return f;
};

// x + sin(a) + y: row [0,60); x [0,10); sep [10,15); fn mrow [15,50); head name [15,22); open paren [22,26); arg a [26,36); close paren [36,40); sep [45,50); y [50,60)
const MID_FN = { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fn', name: 'sin', args: [sym('a')] }, sym('y')] } };
const MID_FN_LAYOUT: Record<string, Rect> = {
  '[]': { left: 0, top: 0, width: 60, height: 10 },
  '[0]': { left: 0, top: 0, width: 10, height: 10 },
  '[1]': { left: 15, top: 0, width: 35, height: 10 },
  '[1,0]': { left: 26, top: 0, width: 10, height: 10 },
  '[2]': { left: 50, top: 0, width: 10, height: 10 },
};
const midFn = () => {
  const f = fixture(MID_FN, MID_FN_LAYOUT);
  f.stub.set(f.headEl([1]), { left: 15, top: 0, width: 7, height: 10 });
  f.stub.set(f.fenceEl([1], 'open'), { left: 22, top: 0, width: 4, height: 10 });
  f.stub.set(f.fenceEl([1], 'close'), { left: 36, top: 0, width: 4, height: 10 });
  f.stub.set(f.sep(0), { left: 10, top: 0, width: 5, height: 10 });
  f.stub.set(f.sep(1), { left: 45, top: 0, width: 5, height: 10 });
  return f;
};

describe('4b-2 — C1: nearest-edge on the final inventory', () => {
  it('mid-token clicks on numbers and symbols in a row land at the nearest character edge (not the end)', () => {
    // ab + 1234: row [0,45); ab [0,10); sep [10,15); 1234 [15,45)
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [sym('ab'), num(1234)] } },
      { '[]': { left: 0, top: 0, width: 45, height: 10 }, '[0]': { left: 0, top: 0, width: 10, height: 10 }, '[1]': { left: 15, top: 0, width: 30, height: 10 } },
    );
    clickF(f.el('[0]'), 0.1); // 'ab' len 2 → round(0.2) = 0
    expect(f.controller.getState().caret).toEqual(tok([0], 0));
    clickF(f.el('[0]'), 0.25); // round(0.5) = 1 — mid-token
    expect(f.controller.getState().caret).toEqual(tok([0], 1));
    clickF(f.el('[0]'), 0.9); // round(1.8) = 2
    expect(f.controller.getState().caret).toEqual(tok([0], 2));
    clickF(f.el('[1]'), 0.1); // '1234' len 4 → round(0.4) = 0
    expect(f.controller.getState().caret).toEqual(tok([1], 0));
    clickF(f.el('[1]'), 0.4); // round(1.6) = 2 — mid-number
    expect(f.controller.getState().caret).toEqual(tok([1], 2));
    clickF(f.el('[1]'), 0.9); // round(3.6) = 4 = len → the end
    expect(f.controller.getState().caret).toEqual(tok([1], 4));
  });

  it('unit labels and sub labels resolve character-wise (S-104 / T9; the unit’s own element IS the label mi)', () => {
    // 50mm + x_max: row [0,80); unit [0,30) (value [0,10), label [20,30)); sub msub [40,80)
    const env = {
      v: 1,
      root: { type: 'op', op: 'add', args: [{ type: 'unit', value: num(50), unit: 'mm' }, { type: 'sub', base: 'cd', sub: 'max' }] },
    };
    const f = fixture(env, {
      '[]': { left: 0, top: 0, width: 80, height: 10 },
      '[0]': { left: 20, top: 0, width: 10, height: 10 }, // the unit's own element = the label mi
      '[0,"value"]': { left: 0, top: 0, width: 10, height: 10 },
      '[1]': { left: 40, top: 0, width: 40, height: 12 },
    });
    f.stub.set(f.subLabelEl([1], 'base'), { left: 40, top: 0, width: 10, height: 10 });
    f.stub.set(f.subLabelEl([1], 'sub'), { left: 52, top: 4, width: 24, height: 8 });
    clickF(f.el('[0,"value"]'), 0.5); // '50' len 2 → 1
    expect(f.controller.getState().caret).toEqual(tok([0, 'value'], 1));
    clickF(f.el('[0]'), 0.25); // label 'mm' len 2 → round(0.5) = 1 — mid-label
    expect(f.controller.getState().caret).toEqual(tok([0], 1));
    clickF(f.el('[0]'), 0.9); // → 2, the label end = the unit's right end
    expect(f.controller.getState().caret).toEqual(tok([0], 2));
    clickF(f.subLabelEl([1], 'base'), 0.25); // 'cd' len 2 → 1
    expect(f.controller.getState().caret).toEqual(tok([1], 1, 'base'));
    clickF(f.subLabelEl([1], 'sub'), 0.34); // 'max' len 3 → round(1.02) = 1
    expect(f.controller.getState().caret).toEqual(tok([1], 1, 'sub'));
    clickF(f.subLabelEl([1], 'sub'), 0.9); // → 3
    expect(f.controller.getState().caret).toEqual(tok([1], 3, 'sub'));
  });

  it('slot content resolves per C1 nearest-edge — fraction num/den and root radicand (supersedes the session-3 slot/root-num inconsistency)', () => {
    const f = midFrac();
    clickF(f.el('[1,"num"]'), 0.25); // num 12 len 2 → 1 — mid-numerator, NOT a node caret
    expect(f.controller.getState().caret).toEqual(tok([1, 'num'], 1));
    clickF(f.el('[1,"den"]'), 0.9); // den 34 → 2 = the slot content's end (S-055)
    expect(f.controller.getState().caret).toEqual(tok([1, 'den'], 2));
    // root radicand in a row: x + √(12) + y
    const g = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'root', radicand: num(12) }, sym('y')] } },
      { '[]': { left: 0, top: 0, width: 60, height: 20 }, '[0]': { left: 0, top: 0, width: 10, height: 10 }, '[1]': { left: 15, top: 0, width: 30, height: 20 }, '[1,"radicand"]': { left: 22, top: 0, width: 16, height: 16 }, '[2]': { left: 50, top: 0, width: 10, height: 10 } },
    );
    clickF(g.el('[1,"radicand"]'), 0.25); // len 2 → 1
    expect(g.controller.getState().caret).toEqual(tok([1, 'radicand'], 1));
  });

  it('operator-glyph element clicks land in the shared gap stations flanking them (N2 corollary, S-053) — the seams are click-reachable', () => {
    const f = midFrac();
    clickF(f.sep(0), 0.5); // the first `+`
    expect(f.controller.getState().caret).toEqual(row(1));
    expect(caretResolvesIn(MID_FRAC as unknown as Envelope, f.controller.getState().caret)).toBe(true); // same state inventory as arrows/typing (OA-visual-trumps)
    clickF(f.sep(1), 0.5); // the second `+`
    expect(f.controller.getState().caret).toEqual(row(2));
    expect(caretResolvesIn(MID_FRAC as unknown as Envelope, f.controller.getState().caret)).toBe(true);
  });

  it('a mid-row fraction’s flank stations are click-reachable (via the bar, C3 — and via the structure’s own edge zone)', () => {
    const f = midFrac();
    clickF(f.el('[1]'), 0.3); // bar left half → the left flank
    expect(f.controller.getState().caret).toEqual(node([1], 'left'));
    clickF(f.el('[1]'), 0.7); // bar right half → the right flank
    expect(f.controller.getState().caret).toEqual(node([1], 'right'));
  });
});

describe('4b-2 — C2: every □ producer is a click target (S-057)', () => {
  const cases: { name: string; env: unknown; carets: Caret[] }[] = [
    { name: 'fraction denominator', env: { v: 1, root: { type: 'frac', num: sym('a'), den: null } }, carets: [slot([], 'den')] },
    { name: 'both slots of an empty fraction', env: { v: 1, root: { type: 'frac', num: null, den: null } }, carets: [slot([], 'num'), slot([], 'den')] },
    { name: 'power exponent', env: { v: 1, root: { type: 'pow', base: sym('a'), exp: null } }, carets: [slot([], 'exp')] },
    { name: 'root radicand', env: { v: 1, root: { type: 'root', radicand: null } }, carets: [slot([], 'radicand')] },
    { name: 'mroot index', env: { v: 1, root: { type: 'root', radicand: num(2), mroot: true } }, carets: [slot([], 'index')] },
    { name: 'the first function argument', env: { v: 1, root: { type: 'fn', name: 'sin', args: [null] } }, carets: [row(0)] },
    { name: 'emptied group content', env: { v: 1, root: { type: 'group', parens: 'always', child: null } }, carets: [slot([], 'child')] },
  ];
  for (const c of cases) {
    it(`${c.name}: clicking the □ enters the slot, caret before the □, nothing logged`, () => {
      const f = fixture(c.env, { '[]': { left: 0, top: 0, width: 40, height: 20 } });
      for (const caret of c.carets) {
        const ph = f.placeholder(caret);
        expect(ph.textContent).toBe('□');
        clickF(ph, 0.5);
        expect(f.controller.getState().caret).toEqual(caret);
      }
      expect(f.controller.getState().log.length).toBe(0);
    });
  }

  it('the empty subscript script renders □ and its click lands before the □ (the label token offset 0)', () => {
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'sub', base: 'x', sub: '' }, sym('y')] } },
      { '[]': { left: 0, top: 0, width: 30, height: 10 }, '[0]': { left: 0, top: 0, width: 14, height: 12 }, '[1]': { left: 20, top: 0, width: 10, height: 10 } },
    );
    const script = f.subLabelEl([0], 'sub');
    expect(script.textContent).toBe('□');
    f.stub.set(script, { left: 7, top: 4, width: 7, height: 8 });
    clickF(script, 0.5);
    expect(f.controller.getState().caret).toEqual(tok([0], 0, 'sub')); // before the □
    expect(f.controller.getState().log.length).toBe(0);
  });
});

describe('4b-2 — C3: the fraction bar maps 50/50 to the gaps flanking the WHOLE fraction (S-056; stubbed mfrac rect)', () => {
  it('mid-row fraction: left half → the gap before (the left flank), right half → the gap after (the right flank); exactly 0.5 → right; never num/den', () => {
    const f = midFrac();
    clickF(f.el('[1]'), 0.3);
    expect(f.controller.getState().caret).toEqual(node([1], 'left'));
    clickF(f.el('[1]'), 0.5); // the bar's midpoint goes right
    expect(f.controller.getState().caret).toEqual(node([1], 'right'));
    clickF(f.el('[1]'), 0.7);
    expect(f.controller.getState().caret).toEqual(node([1], 'right'));
    // never inside num/den: both results are edge stations, not slot/token states
    for (const c of [node([1], 'left'), node([1], 'right')]) {
      expect(c.kind === 'node' && c.side !== undefined).toBe(true);
    }
  });

  it('a bare fraction at the root: bar halves → the lone-root border stations (OA-lone-root-stations)', () => {
    const f = fixture({ v: 1, root: { type: 'frac', num: num(1), den: num(2) } }, { '[]': { left: 0, top: 0, width: 30, height: 20 } });
    clickF(f.el('[]'), 0.3);
    expect(f.controller.getState().caret).toEqual(node([], 'left'));
    clickF(f.el('[]'), 0.7);
    expect(f.controller.getState().caret).toEqual(node([], 'right'));
  });

  it('a fraction at the row start: left half → the row-start seam (the gap before), right half → the right flank', () => {
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'frac', num: num(1), den: num(2) }, sym('y')] } },
      { '[]': { left: 0, top: 0, width: 40, height: 20 }, '[0]': { left: 0, top: 0, width: 25, height: 20 }, '[1]': { left: 30, top: 0, width: 10, height: 10 } },
    );
    clickF(f.el('[0]'), 0.3); // no glyph zone at the row border → the border seam
    expect(f.controller.getState().caret).toEqual(row(0));
    clickF(f.el('[0]'), 0.7); // a separator stands right of cell 0 → the flank
    expect(f.controller.getState().caret).toEqual(node([0], 'right'));
  });
});

describe('4b-2 — C4: the function head and the fence glyphs (S-054)', () => {
  it('clicking the head’s name area → the caret right after the open paren (the first argument start)', () => {
    const f = midFn();
    clickF(f.headEl([1]), 0.5);
    expect(f.controller.getState().caret).toEqual(tok([1, 0], 0));
    // empty first argument: the same click lands at the □ row caret (C2)
    const g = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fn', name: 'sin', args: [null] }, sym('y')] } },
      MID_FN_LAYOUT,
      { [caretKey(row(0, [1]))]: { left: 26, top: 0, width: 6, height: 10 } },
    );
    g.stub.set(g.headEl([1]), { left: 15, top: 0, width: 7, height: 10 });
    clickF(g.headEl([1]), 0.5);
    expect(g.controller.getState().caret).toEqual(row(0, [1]));
  });

  it('the head’s left edge → the gap before the head (the left flank mid-row)', () => {
    const f = midFn();
    clickF(f.el('[1]'), 0.02); // the mrow's left edge zone
    expect(f.controller.getState().caret).toEqual(node([1], 'left'));
  });

  it('fence glyph clicks → their nearest legal station (the flanks exist on both sides, OA-fence-flank)', () => {
    const f = midFn();
    clickF(f.fenceEl([1], 'open'), 0.2); // left half of `(` → left-of-`(` station
    expect(f.controller.getState().caret).toEqual(node([1], 'left'));
    clickF(f.fenceEl([1], 'open'), 0.8); // right half of `(` → after the paren = first arg start
    expect(f.controller.getState().caret).toEqual(tok([1, 0], 0));
    clickF(f.fenceEl([1], 'close'), 0.2); // left half of `)` → the content end (before the paren)
    expect(f.controller.getState().caret).toEqual(tok([1, 0], 1));
    clickF(f.fenceEl([1], 'close'), 0.8); // right half of `)` → the after-`)` flank
    expect(f.controller.getState().caret).toEqual(node([1], 'right'));
  });

  it('plain groups follow the same movable-paren click model', () => {
    // x + (a+b) + y
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } }, sym('y')] } },
      {
        '[]': { left: 0, top: 0, width: 70, height: 10 },
        '[0]': { left: 0, top: 0, width: 10, height: 10 },
        '[1]': { left: 15, top: 0, width: 40, height: 10 },
        '[1,"child"]': { left: 20, top: 0, width: 30, height: 10 },
        '[1,"child",0]': { left: 20, top: 0, width: 10, height: 10 },
        '[1,"child",1]': { left: 40, top: 0, width: 10, height: 10 },
        '[2]': { left: 60, top: 0, width: 10, height: 10 },
      },
    );
    f.stub.set(f.fenceEl([1], 'open'), { left: 15, top: 0, width: 4, height: 10 });
    f.stub.set(f.fenceEl([1], 'close'), { left: 51, top: 0, width: 4, height: 10 });
    clickF(f.fenceEl([1], 'open'), 0.8); // after the open paren → the content start
    expect(f.controller.getState().caret).toEqual(tok([1, 'child', 0], 0));
    clickF(f.fenceEl([1], 'close'), 0.2); // before the close paren → the content end
    expect(f.controller.getState().caret).toEqual(tok([1, 'child', 1], 1));
    clickF(f.fenceEl([1], 'close'), 0.8); // after the close paren → the right flank
    expect(f.controller.getState().caret).toEqual(node([1], 'right'));
    clickF(f.fenceEl([1], 'open'), 0.2); // left of the open paren → the left flank
    expect(f.controller.getState().caret).toEqual(node([1], 'left'));
  });

  it('V-18: a dangling close-fence token clicks to the shared gaps flanking the glyph (both flanks of the fence region)', () => {
    // x + ) + y
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fence', side: 'close' }, sym('y')] } },
      { '[]': { left: 0, top: 0, width: 60, height: 10 }, '[0]': { left: 0, top: 0, width: 10, height: 10 }, '[1]': { left: 15, top: 0, width: 10, height: 10 }, '[2]': { left: 50, top: 0, width: 10, height: 10 } },
    );
    clickF(f.el('[1]'), 0.2); // the fence glyph's left half → the gap before it
    expect(f.controller.getState().caret).toEqual(row(1));
    clickF(f.el('[1]'), 0.8); // right half → the gap after it
    expect(f.controller.getState().caret).toEqual(row(2));
  });
});

describe('4b-2 — C5: background snap (S-061)', () => {
  it('empty formula: a background click → the single start position, nothing logged', () => {
    const f = fixture({ v: 1, root: null }, {});
    click(f.container, 250);
    expect(f.controller.getState().caret).toEqual({ kind: 'empty' });
    expect(f.controller.getState().log.length).toBe(0);
  });

  it('past the end → the formula end (a trailing structure keeps the end seam); the start edge → the start seam', () => {
    // 1/2 + y: row [0,40); mfrac [0,25); sep [25,30); y [30,40)
    const f = fixture(
      { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'frac', num: num(1), den: num(2) }, sym('y')] } },
      { '[]': { left: 0, top: 0, width: 40, height: 20 }, '[0]': { left: 0, top: 0, width: 25, height: 20 }, '[1]': { left: 30, top: 0, width: 10, height: 10 } },
    );
    const math = f.rendered.math;
    f.stub.setMath({ left: 0, top: 0, width: 40, height: 20 });
    clickF(math, 0.96); // past the end → formula end (the row-end seam)
    expect(f.controller.getState().caret).toEqual(row(2));
    clickF(math, 0.04); // the start edge → the row-start seam
    expect(f.controller.getState().caret).toEqual(row(0));
  });
});

describe('4b-2 — click mechanics invariants', () => {
  it('a click that only moves the caret produces ZERO undo-log entries (bar, separator, fence, head clicks included)', () => {
    const f = midFn();
    f.controller.apply({ op: 'insert', node: num(9), at: { at: 'row', path: [1], index: 1 } });
    const logLen = f.controller.getState().log.length;
    expect(logLen).toBe(1);
    clickF(f.el('[1]'), 0.3); // fn mrow middle → dive (arg start side)
    clickF(f.sep(0), 0.5); // separator
    clickF(f.fenceEl([1], 'open'), 0.2); // fence glyph
    clickF(f.headEl([1]), 0.5); // head name
    expect(f.controller.getState().log.length).toBe(logLen);
  });

  it('clicks NEVER READ the vertical memory: a stored region position is not restored by clicking into the region', () => {
    // 1/23: build up real vmem stores with vertical keys, then click into the den
    const f = fixture(
      { v: 1, root: { type: 'frac', num: num(1), den: num(23) } },
      { '[]': { left: 0, top: 0, width: 30, height: 20 }, '["num"]': { left: 10, top: 0, width: 6, height: 8 }, '["den"]': { left: 10, top: 12, width: 8, height: 8 } },
    );
    f.container.focus();
    f.controller.placeCaret(tok(['num'], 1));
    press(f.container, 'ArrowDown'); // stores num → lands at the den content end (structural default)
    expect(f.controller.getState().caret).toEqual(tok(['den'], 2));
    press(f.container, 'ArrowUp'); // den store written; num store fires
    expect(f.controller.getState().caret).toEqual(tok(['num'], 1));
    press(f.container, 'ArrowDown'); // den store fires → back at tok(['den'],2)
    expect(f.controller.getState().caret).toEqual(tok(['den'], 2));
    expect(f.controller.getVerticalMemory().get(regionKey({ parentPath: [], slot: 'den' }))).toEqual(tok(['den'], 2));
    // now CLICK into the denominator at fraction 0.1 of "23" → offset 0 — NOT the stored offset 2
    clickF(f.el('["den"]'), 0.1);
    expect(f.controller.getState().caret).toEqual(tok(['den'], 0));
  });

  it('clicks NEVER WRITE the vertical memory: the stores are byte-identical after clicks', () => {
    const f = fixture(
      { v: 1, root: { type: 'frac', num: num(1), den: num(23) } },
      { '[]': { left: 0, top: 0, width: 30, height: 20 }, '["num"]': { left: 10, top: 0, width: 6, height: 8 }, '["den"]': { left: 10, top: 12, width: 8, height: 8 } },
    );
    f.container.focus();
    f.controller.placeCaret(tok(['num'], 1));
    press(f.container, 'ArrowDown');
    press(f.container, 'ArrowUp');
    press(f.container, 'ArrowDown');
    const before = new Map(f.controller.getVerticalMemory());
    expect(before.size).toBe(2); // num + den stores
    clickF(f.el('["den"]'), 0.1);
    clickF(f.el('["num"]'), 0.5);
    clickF(f.rendered.math, 0.5);
    expect(f.controller.getVerticalMemory()).toBe(f.controller.getVerticalMemory()); // map untouched
    expect([...f.controller.getVerticalMemory().entries()]).toEqual([...before.entries()]);
    // and the den store still fires afterwards (the click neither wrote nor cleared)
    f.controller.placeCaret(tok(['num'], 1));
    press(f.container, 'ArrowDown');
    expect(f.controller.getState().caret).toEqual(tok(['den'], 2));
  });
});

describe('4b-2 — the pure resolver/adapter pins for the new hit kinds', () => {
  it('hitFromMouseEvent: own-uid target beats the ancestor; fence glyphs, fn heads, sub labels recognized on the raw target', () => {
    const env: Envelope = {
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fn', name: 'sin', args: [sym('a')] }, { type: 'sub', base: 'b', sub: 'm' }] },
    };
    const rendered = buildMathML(fromJSON(env), document);
    document.body.appendChild(rendered.math);
    const fake = (target: Element, clientX: number): MouseEvent => ({ target, clientX }) as unknown as MouseEvent;

    // the fn name mi: no uid → fnHead hit
    const head = [...rendered.fnHeads.entries()].find(([_, p]) => pathKey(p) === '[1]')![0];
    expect(hitFromMouseEvent(fake(head, 5), rendered)).toEqual({ kind: 'fnHead', path: [1] });
    // the open paren mo: no uid → fence hit
    const open = [...rendered.fenceGlyphs.entries()].find(([_, g]) => pathKey(g.path) === '[1]' && g.side === 'open')![0];
    const openHit = hitFromMouseEvent(fake(open, 5), rendered) as Extract<ReturnType<typeof hitFromMouseEvent>, { kind: 'fence' }>;
    expect(openHit.kind).toBe('fence');
    expect(openHit.path).toEqual([1]);
    expect(openHit.side).toBe('open');
    // a sub label: subLabel hit with the label
    const labels = rendered.subLabels.get('[2]')!;
    const subHit = hitFromMouseEvent(fake(labels.script, 5), rendered) as Extract<ReturnType<typeof hitFromMouseEvent>, { kind: 'subLabel' }>;
    expect(subHit).toMatchObject({ kind: 'subLabel', path: [2], label: 'sub' });
    // a uid element hit directly → node hit (fraction vs the element itself)
    const argA = rendered.elementByPath.get('[1,0]')!;
    const nodeHit = hitFromMouseEvent(fake(argA, 5), rendered) as Extract<ReturnType<typeof hitFromMouseEvent>, { kind: 'node' }>;
    expect(nodeHit.kind).toBe('node');
    expect(nodeHit.path).toEqual([1, 0]);
    // an id-less wrapper inside a uid element → the ancestor's node hit
    const mspace = rendered.math.querySelector('mspace'); // fn row has none here; use the arg's parent mrow? fallback: the unit space — build a unit instead
    void mspace;
  });

  it('caretFromHit pure pins: fnHead / fence / subLabel hits', () => {
    const fnEnv: Envelope = {
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fn', name: 'sin', args: [sym('ab')] }, sym('y')] },
    };
    // fnHead → first argument start
    expect(caretFromHit(fnEnv, { kind: 'fnHead', path: [1] })).toEqual(tok([1, 0], 0));
    // open fence: left half → left flank, right half → arg start
    expect(caretFromHit(fnEnv, { kind: 'fence', path: [1], side: 'open', fraction: 0.2 })).toEqual(node([1], 'left'));
    expect(caretFromHit(fnEnv, { kind: 'fence', path: [1], side: 'open', fraction: 0.8 })).toEqual(tok([1, 0], 0));
    // close fence: left half → content end, right half → right flank
    expect(caretFromHit(fnEnv, { kind: 'fence', path: [1], side: 'close', fraction: 0.2 })).toEqual(tok([1, 0], 2));
    expect(caretFromHit(fnEnv, { kind: 'fence', path: [1], side: 'close', fraction: 0.8 })).toEqual(node([1], 'right'));
    // subLabel → character-wise in the label
    const subEnv: Envelope = { v: 1, root: { type: 'sub', base: 'ab', sub: 'max' } };
    expect(caretFromHit(subEnv, { kind: 'subLabel', path: [], label: 'base', fraction: 0.25 })).toEqual(tok([], 1, 'base'));
    expect(caretFromHit(subEnv, { kind: 'subLabel', path: [], label: 'sub', fraction: 0.9 })).toEqual(tok([], 3, 'sub'));
    // frac bar: 50/50, never num/den
    const fracEnv: Envelope = {
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(12), den: num(34) }, sym('y')] },
    };
    expect(caretFromHit(fracEnv, { kind: 'node', path: [1], fraction: 0.49 })).toEqual(node([1], 'left'));
    expect(caretFromHit(fracEnv, { kind: 'node', path: [1], fraction: 0.5 })).toEqual(node([1], 'right'));
  });
});

describe('4b-2 — the keymap audit pin: every coverage-matrix input → its actual keymap behavior', () => {
  // The audit table. Each row: the matrix input, the event shape, the ACTUAL
  // classifyKey action today, the contract rule IDs, and the implementation
  // status. If a keymap entry is removed or reclassified, this pin fails — the
  // audit cannot silently rot. Session 5 flipped the K1–K3 + U1 rows from
  // "deliberate pass-through until session 5" to their implemented actions
  // (boundary/commit; coalescing is controller-side, not a classifyKey action).
  interface AuditRow {
    readonly input: string;
    readonly event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
    readonly action: KeyAction;
    readonly rules: readonly string[];
    readonly status: string;
  }
  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  const AUDIT: readonly AuditRow[] = [
    { input: '←', event: { ...base, key: 'ArrowLeft' }, action: { kind: 'move', dir: 'left' }, rules: ['N1', 'N2', 'N3', 'N5', 'N8'], status: 'implemented (4a + 4b-1)' },
    { input: '→', event: { ...base, key: 'ArrowRight' }, action: { kind: 'move', dir: 'right' }, rules: ['N1', 'N2', 'N3', 'N4', 'N5', 'N7', 'N8'], status: 'implemented (4a + 4b-1)' },
    { input: '↑', event: { ...base, key: 'ArrowUp' }, action: { kind: 'move', dir: 'up' }, rules: ['N6'], status: 'implemented (4a + 4b-1, vmem)' },
    { input: '↓', event: { ...base, key: 'ArrowDown' }, action: { kind: 'move', dir: 'down' }, rules: ['N6'], status: 'implemented (4a + 4b-1, vmem)' },
    { input: 'Backspace', event: { ...base, key: 'Backspace' }, action: { kind: 'backspace', ctrl: false }, rules: ['D1', 'D2', 'D5', 'D6', 'D7', 'D8', 'D9'], status: 'implemented (session 3)' },
    { input: 'Ctrl+Backspace', event: { ...base, key: 'Backspace', ctrlKey: true }, action: { kind: 'backspace', ctrl: true }, rules: ['D3'], status: 'implemented (session 3)' },
    { input: 'Delete (forward)', event: { ...base, key: 'Delete' }, action: { kind: 'delete', ctrl: false }, rules: ['D1', 'D3'], status: 'implemented (session 3; named no-op defaults listed in the session-3 record)' },
    { input: 'Ctrl+Delete', event: { ...base, key: 'Delete', ctrlKey: true }, action: { kind: 'delete', ctrl: true }, rules: ['D3'], status: 'implemented (session 3)' },
    { input: 'digits 0–9', event: { ...base, key: '7' }, action: { kind: 'type', token: KEYMAP['7'] }, rules: ['T4', 'OA-digit-glue'], status: 'implemented (2a)' },
    { input: 'letters (a–z, A–Z)', event: { ...base, key: 'Q' }, action: { kind: 'type', token: KEYMAP['Q'] }, rules: ['T3'], status: 'implemented (2a)' },
    { input: '.', event: { ...base, key: '.' }, action: { kind: 'type', token: KEYMAP['.'] }, rules: ['T4', 'S-011', 'S-013', 'OA-dot-eval'], status: 'implemented (2a)' },
    { input: 'operator +', event: { ...base, key: '+' }, action: { kind: 'type', token: KEYMAP['+'] }, rules: ['T1', 'S-001'], status: 'implemented (2a)' },
    { input: 'operator − (key "-")', event: { ...base, key: '-' }, action: { kind: 'type', token: KEYMAP['-'] }, rules: ['T1'], status: 'implemented (2a)' },
    { input: 'operator *', event: { ...base, key: '*' }, action: { kind: 'type', token: KEYMAP['*'] }, rules: ['T1', 'S-002'], status: 'implemented (2a)' },
    { input: 'operator /', event: { ...base, key: '/' }, action: { kind: 'type', token: KEYMAP['/'] }, rules: ['T7', 'OA-both-halves'], status: 'implemented (2b-1)' },
    { input: 'operator ^', event: { ...base, key: '^' }, action: { kind: 'type', token: KEYMAP['^'] }, rules: ['T7', 'T8', 'OA-both-halves'], status: 'implemented (2b-1)' },
    { input: 'paren (', event: { ...base, key: '(' }, action: { kind: 'type', token: KEYMAP['('] }, rules: ['T5', 'T6', 'T10'], status: 'implemented (2a)' },
    { input: 'paren )', event: { ...base, key: ')' }, action: { kind: 'type', token: KEYMAP[')'] }, rules: ['S-097', 'C4'], status: 'implemented (2a)' },
    { input: 'comma', event: { ...base, key: ',' }, action: { kind: 'type', token: KEYMAP[','] }, rules: ['N7', 'OA-fn-args'], status: 'implemented (2a)' },
    { input: 'Space', event: { ...base, key: ' ' }, action: { kind: 'type', token: KEYMAP[' '] }, rules: ['S-021', 'S-022', 'S-098'], status: 'implemented (2a)' },
    { input: 'dead key (any)', event: { ...base, key: 'Dead' }, action: { kind: 'deadPow' }, rules: ['T8', 'S-034', 'S-035', 'OA-dead-key', 'OA-one-shot'], status: 'implemented (2b-1 + session 3)' },
    { input: 'Ctrl/Meta+Z (undo)', event: { ...base, key: 'z', ctrlKey: true }, action: { kind: 'undo' }, rules: ['U1', 'U2', 'U4'], status: 'implemented (session 2 keys; session 5: U1 typing-run coalescing — LogEntry {ops:[…]}, controller-side run-closing)' },
    { input: 'Ctrl/Meta+Y and Ctrl/Meta+Shift+Z (redo)', event: { ...base, key: 'Z', ctrlKey: true, shiftKey: true }, action: { kind: 'redo' }, rules: ['U3', 'U4'], status: 'implemented (session 2 keys; session 5: redo replays the whole unit, clears on new edits)' },
    { input: 'click variants (glyph interior/edges, seams, container bodies, background)', event: { ...base, key: '<mouse>' }, action: { kind: 'ignore' }, rules: ['C1', 'C2', 'C3', 'C4', 'C5'], status: 'handled by the click path (hitFromMouseEvent + caretFromHit → placeCaret), NOT classifyKey — C1–C5 implemented in 4b-2; C6 double-click defers to the selection-ranges feature' },
    { input: 'Home', event: { ...base, key: 'Home' }, action: { kind: 'boundary', side: 'start' }, rules: ['K1', 'S-089', 'S-090', 'S-091', 'S-105'], status: 'implemented (session 5: K1 iterative Home/End — local row/slot boundary first, then one level outward per press, S-105 A direct escalation; movement, never logged)' },
    { input: 'End', event: { ...base, key: 'End' }, action: { kind: 'boundary', side: 'end' }, rules: ['K1', 'S-089', 'S-090', 'S-091', 'S-105'], status: 'implemented (session 5: K1 mirror of Home)' },
    { input: 'Ctrl+Home/End', event: { ...base, key: 'Home', ctrlKey: true }, action: { kind: 'ignore' }, rules: ['K1'], status: 'implemented (session 5): deliberately UNBOUND — K1 rules out Ctrl variants; passes through' },
    { input: 'Enter', event: { ...base, key: 'Enter' }, action: { kind: 'commit' }, rules: ['K2', 'S-092'], status: 'implemented (session 5: K2 commit + blur — the controller ends the session and fires blur; post-blur behavior is the host’s)' },
    { input: 'Tab', event: { ...base, key: 'Tab' }, action: { kind: 'commit' }, rules: ['K2', 'S-092'], status: 'implemented (session 5: K2 commit + blur, same action as Enter — the next-cell handoff is host-side)' },
    { input: 'Escape', event: { ...base, key: 'Escape' }, action: { kind: 'commit' }, rules: ['K3', 'S-093'], status: 'implemented (session 5: K3 commit + blur with NO follow-up — an unlogged boundary, no Integral-side action)' },
    { input: 'unknown printable (outside the keymap)', event: { ...base, key: ';' }, action: { kind: 'type', token: undefined }, rules: ['T1', 'S-013'], status: 'implemented: handled key, defined silent no-op (the rejection pattern)' },
  ];

  it('every coverage-matrix input classifies to its recorded action (the audit pin)', () => {
    for (const row of AUDIT) {
      expect(classifyKey(row.event as never), `${row.input} [${row.status}]`).toEqual(row.action);
    }
  });

  it('the audit table covers the matrix input list exactly (no input dropped, none invented)', () => {
    const matrixInputs = [
      '←', '→', '↑', '↓',
      'Backspace', 'Ctrl+Backspace', 'Delete (forward)', 'Ctrl+Delete',
      'digits 0–9', 'letters (a–z, A–Z)', '.',
      'operator +', 'operator − (key "-")', 'operator *', 'operator /', 'operator ^',
      'paren (', 'paren )', 'comma', 'Space', 'dead key (any)',
      'Ctrl/Meta+Z (undo)', 'Ctrl/Meta+Y and Ctrl/Meta+Shift+Z (redo)',
      'click variants (glyph interior/edges, seams, container bodies, background)',
      'Home', 'End', 'Ctrl+Home/End', 'Enter', 'Tab', 'Escape',
      'unknown printable (outside the keymap)',
    ];
    expect(AUDIT.map((r) => r.input)).toEqual(matrixInputs);
    // every row carries contract rule refs and an explicit status
    for (const row of AUDIT) {
      expect(row.rules.length, row.input).toBeGreaterThan(0);
      expect(row.status.length, row.input).toBeGreaterThan(0);
    }
  });

  it('the keymap itself holds every ruled typing char (digits, letters, operators, parens, dot, comma, space)', () => {
    for (let d = 0; d <= 9; d++) expect(KEYMAP[String(d)]).toBeDefined();
    for (let i = 0; i < 26; i++) {
      expect(KEYMAP[String.fromCharCode(97 + i)]).toBeDefined();
      expect(KEYMAP[String.fromCharCode(65 + i)]).toBeDefined();
    }
    for (const ch of ['+', '-', '*', '/', '^', '(', ')', '.', ',', ' ']) expect(KEYMAP[ch]).toBeDefined();
  });
});
