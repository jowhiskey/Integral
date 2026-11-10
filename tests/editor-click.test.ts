// @vitest-environment jsdom
// Click → structural caret mapping. jsdom has no layout: element rects are stubbed
// (the established rect-stub pattern, synced by path key). Clicks are real bubbling
// MouseEvents dispatched on the target element; the controller's handler resolves
// them through the UID maps. Pins: leaf left/right halves → adjacent row seams,
// separator glyphs → their seam, container halves → flow ends, placeholders →
// their slot/row caret, empty formula → empty caret — and placement never touches
// the undo log.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromJSON, toJSON, type Envelope } from '../src/ast/index.js';
import type { Caret } from '../src/engine/index.js';
import { caretFromHit, hitFromMouseEvent, type ClickHit } from '../src/editor/click.js';
import { EditorController } from '../src/editor/controller.js';
import { buildMathML, caretKey, pathKey } from '../src/editor/mathml-dom.js';
import { stubRects, type Rect, type RectStub } from './editor-support.js';

afterEach(() => vi.restoreAllMocks());

const sym = (name: string) => ({ type: 'sym', name }) as const;
const num = (value: number) => ({ type: 'num', value }) as const;

interface Fixture {
  controller: EditorController;
  container: HTMLDivElement;
  stub: RectStub;
  el: (path: string) => Element;
  sep: (i: number) => Element;
  placeholder: (caret: Caret) => Element;
}

/** A controller for `envelope` in a fresh container; rects synced by path/caret key. */
function fixture(envelope: unknown, byPath: Record<string, Rect>, byCaret: Record<string, Rect> = {}): Fixture {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  const stub = stubRects({ container: { left: 100, top: 50, width: 300, height: 40 } });
  stub.setMath({ left: 100, top: 50, width: 300, height: 40 });
  const controller = new EditorController(container, { envelope });
  const rendered = controller.getRendered()!;
  stub.syncPath(rendered, byPath);
  stub.syncCaret(rendered, byCaret);
  controller.updateCaret();
  return {
    controller,
    container,
    stub,
    el: (path: string) => controller.getRendered()!.elementByPath.get(path)!,
    sep: (i: number) => [...controller.getRendered()!.separators.keys()][i],
    placeholder: (caret: Caret) => controller.getRendered()!.placeholderByCaret.get(caretKey(caret))!,
  };
}

const click = (el: Element, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX }));
};

const row = (index: number, path: (number | string)[] = []): Caret => ({ kind: 'row', path, index });
const node = (path: (number | string)[] = []): Caret => ({ kind: 'node', path });

describe('click mapping: args row (a+b+c)', () => {
  const env = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } };
  // row mrow [0,35), a [0,10), sep [10,15), b [15,25), sep [25,30), c [30,35)
  const layout: Record<string, Rect> = {
    '[]': { left: 0, top: 0, width: 35, height: 10 },
    '[0]': { left: 0, top: 0, width: 10, height: 10 },
    '[1]': { left: 15, top: 0, width: 10, height: 10 },
    '[2]': { left: 30, top: 0, width: 5, height: 10 },
  };
  const mk = () => fixture(env, layout);

  it('leaf clicks resolve character-wise (C1 nearest-edge, S-058/S-060): the nearest character edge of the token, not the row seam', () => {
    // 4b-2 re-pin: symbols are text-like tokens (N1) — a click at the left/right
    // half of a single-char token lands at its offset 0 / len, not at a seam.
    const f = mk();
    click(f.el('[1]'), 17); // fraction 0.2 of b (len 1) → offset 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [1], index: 0 });
    click(f.el('[1]'), 24); // fraction 0.9 → offset 1
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [1], index: 1 });
    click(f.el('[0]'), 4); // fraction 0.4 → offset 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0], index: 0 });
    click(f.el('[0]'), 9); // fraction 0.9 → offset 1
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0], index: 1 });
    click(f.el('[2]'), 31); // fraction 0.2 → offset 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [2], index: 0 });
    click(f.el('[2]'), 34); // fraction 0.8 → offset 1
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [2], index: 1 });
  });

  it('separator glyph click → the seam it sits on', () => {
    const f = mk();
    click(f.sep(0), 12);
    expect(f.controller.getState().caret).toEqual(row(1));
    click(f.sep(1), 27);
    expect(f.controller.getState().caret).toEqual(row(2));
  });

  it('row container click → nearest end (dive into the flow end); fraction 0.5 goes right', () => {
    const f = mk();
    click(f.el('[]'), 2); // fraction ~0.06
    // 4a re-pin (OA-visual-trumps): the flow-end benches are in-token carets
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0], index: 0 });
    click(f.el('[]'), 34);
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [2], index: 1 });
    click(f.el('[]'), 17.5); // fraction exactly 0.5 → right side
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [2], index: 1 });
    click(f.el('[]'), 17); // 17/35 < 0.5 → left side
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0], index: 0 });
  });

  it('placement is pure state: the undo log length is unchanged by clicks', () => {
    const f = mk();
    f.controller.apply({ op: 'insert', node: num(9), at: { at: 'row', path: [], index: 3 } });
    const logLen = f.controller.getState().log.length;
    expect(logLen).toBe(1);
    click(f.el('[1]'), 17);
    click(f.el('[]'), 34); // right end — the inserted 9 is now the last cell
    expect(f.controller.getState().log.length).toBe(logLen);
    // 4a re-pin (OA-visual-trumps): the flow-end bench — the 9's in-token end
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [3], index: 1 });
  });
});

describe('click mapping: fraction with null num, filled den', () => {
  const env = { v: 1, root: { type: 'frac', num: null, den: num(2) } };
  const layout: Record<string, Rect> = {
    '[]': { left: 0, top: 0, width: 20, height: 20 },
    '["den"]': { left: 10, top: 10, width: 10, height: 10 },
  };
  const numSlotCaret: Caret = { kind: 'slot', path: [], slot: 'num' };
  const caretLayout = { [caretKey(numSlotCaret)]: { left: 2, top: 2, width: 6, height: 6 } };

  it('container left half → empty num slot caret; right half → dive into den', () => {
    const f = fixture(env, layout, caretLayout);
    click(f.el('[]'), 2); // fraction 0.1 — an edge-zone click: the outside now carries a station (4a)
    expect(f.controller.getState().caret).toEqual({ kind: 'node', path: [], side: 'left' });
    click(f.el('[]'), 18); // fraction 0.9 — the mirrored edge zone
    expect(f.controller.getState().caret).toEqual({ kind: 'node', path: [], side: 'right' });
  });

  it('placeholder click → its slot caret (C2); a leaf in a slot resolves character-wise too (C1 — supersedes the session-3 slot node-caret pin)', () => {
    const f = fixture(env, layout, caretLayout);
    click(f.placeholder(numSlotCaret), 3);
    expect(f.controller.getState().caret).toEqual(numSlotCaret);
    click(f.el('["den"]'), 11); // fraction 0.1 of "2" (len 1) → offset 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: ['den'], index: 0 });
    click(f.el('["den"]'), 19); // fraction 0.9 → offset 1 (the slot content's end, S-055)
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: ['den'], index: 1 });
  });
});

describe('click mapping: empty row cell, empty formula, unit, group nesting', () => {
  it('the FIRST fn arg null → its □ placeholder → row caret in the empty arg (re-pinned per the owner\'s B-23 live ruling: the □ lives on the first argument only)', () => {
    // Re-pinned (the owner's B-23 ruling): a fn argument beyond the first
    // renders BARE when empty — placeholder-click coverage lives on the
    // FIRST argument; a bare later empty arg is reached via its comma.
    const env = { v: 1, root: { type: 'fn', name: 'f', args: [null, sym('a')] } };
    const cellCaret: Caret = row(0);
    const f = fixture(env, { '[]': { left: 0, top: 0, width: 20, height: 10 }, '[1]': { left: 0, top: 0, width: 10, height: 10 } }, {
      [caretKey(cellCaret)]: { left: 2, top: 0, width: 6, height: 10 },
    });
    click(f.placeholder(cellCaret), 14);
    expect(f.controller.getState().caret).toEqual(cellCaret);
  });

  it('a bare fn empty SECOND argument: clicking its comma reaches the empty cell (the op-row bare analog)', () => {
    const env = { v: 1, root: { type: 'fn', name: 'f', args: [sym('a'), null] } };
    const f = fixture(env, { '[]': { left: 0, top: 0, width: 20, height: 10 }, '[0]': { left: 0, top: 0, width: 10, height: 10 } });
    click(f.sep(0), 12);
    expect(f.controller.getState().caret).toEqual(row(1));
  });

  it('bare op-row null cell: clicking the flanking separator glyph reaches the empty cell', () => {
    // add(a, null) renders `a+` — the trailing glyph is the empty cell's left
    // neighbor; its click maps to the row seam at index 1 (the empty cell).
    const env = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null] } };
    const f = fixture(env, { '[]': { left: 0, top: 0, width: 15, height: 10 }, '[0]': { left: 0, top: 0, width: 10, height: 10 } });
    const sep = [...f.controller.getRendered()!.separators.keys()];
    expect(sep.length).toBe(1);
    click(sep[0], 12);
    expect(f.controller.getState().caret).toEqual(row(1));
  });

  it('empty formula: any click → the empty caret, log stays empty', () => {
    const f = fixture({ v: 1, root: null }, {});
    click(f.container, 150);
    expect(f.controller.getState().caret).toEqual({ kind: 'empty' });
    expect(f.controller.getState().log.length).toBe(0);
  });

  it('unit: the value clicks character-wise (C1); the unit’s own element IS the upright label — its clicks resolve character-wise in the label (C1/S-104)', () => {
    // 4b-2 re-pin: the unit's own uid element is the label mi, so a click on it
    // addresses the label in-token (not the value's left entry the container
    // dive produced before).
    const env = { v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } };
    const f = fixture(env, {
      '[]': { left: 24, top: 0, width: 6, height: 10 },
      '["value"]': { left: 0, top: 0, width: 10, height: 10 },
    });
    click(f.el('["value"]'), 5); // fraction 0.5 of "50" (len 2) → offset 1, between 5 and 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: ['value'], index: 1 });
    click(f.el('[]'), 25); // fraction ~0.17 of the label "mm" → label offset 0
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [], index: 0 });
    click(f.el('[]'), 29); // fraction ~0.83 → the label's in-token END is the unit's right end (OA-token-end)
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [], index: 2 });
  });

  it('deepest uid wins: clicking a child inside a group hits the child, not the group', () => {
    const env = {
      v: 1,
      root: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
    };
    const f = fixture(env, {
      '[]': { left: 0, top: 0, width: 30, height: 10 },
      '["child"]': { left: 2, top: 0, width: 26, height: 10 },
      '["child",0]': { left: 2, top: 0, width: 10, height: 10 },
      '["child",1]': { left: 18, top: 0, width: 10, height: 10 },
    });
    click(f.el('["child",1]'), 19); // fraction 0.1 of b (len 1) → its offset 0 (C1 character-wise, 4b-2 re-pin)
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: ['child', 1], index: 0 });
  });
});

describe('caretFromHit + hitFromMouseEvent: the pure resolver and the event adapter', () => {
  const env: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };

  it('caretFromHit: separator / placeholder / none / leaf-root / unresolvable hits', () => {
    expect(caretFromHit(env, { kind: 'separator', path: [], index: 1 })).toEqual(row(1));

    const slotCaret: Caret = { kind: 'slot', path: [], slot: 'num' };
    expect(
      caretFromHit({ v: 1, root: { type: 'frac', num: null, den: num(2) } }, { kind: 'placeholder', caret: slotCaret }),
    ).toEqual(slotCaret);

    expect(caretFromHit({ v: 1, root: null }, { kind: 'none', fraction: 0.2 })).toEqual({ kind: 'empty' });
    // background border zones park at the root row's border seams (amended
    // session 4: the start/end of the formula are stations); the middle
    // zones keep the enter-from-side dive
    expect(caretFromHit(env, { kind: 'none', fraction: 0.04 })).toEqual(row(0));
    // 4a re-pin (OA-visual-trumps): the enter-from-side dives are in-token benches
    expect(caretFromHit(env, { kind: 'none', fraction: 0.4 })).toEqual({ kind: 'token', path: [0], index: 0 });
    expect(caretFromHit(env, { kind: 'none', fraction: 0.6 })).toEqual({ kind: 'token', path: [1], index: 1 });
    expect(caretFromHit(env, { kind: 'none', fraction: 0.96 })).toEqual(row(2));

    // 4b-2 re-pin (C1): a root num leaf clicks character-wise → its offset 0
    expect(caretFromHit({ v: 1, root: num(7) }, { kind: 'node', path: [], fraction: 0.2 })).toEqual({ kind: 'token', path: [], index: 0 });
    // an unresolvable node path falls back to the root's end station (4b-2: the
    // entryStation fallback, not a bare node caret)
    expect(caretFromHit(env, { kind: 'node', path: [9], fraction: 0.2 })).toEqual({ kind: 'token', path: [1], index: 1 });
  });

  it('hitFromMouseEvent maps a raw event through the rendered maps', () => {
    const rendered = buildMathML(fromJSON(env), document);
    document.body.appendChild(rendered.math);
    const fake = (target: Element, clientX: number): MouseEvent => ({ target, clientX }) as unknown as MouseEvent;

    const nodeHit = hitFromMouseEvent(fake(rendered.elementByPath.get(pathKey([1]))!, 5), rendered) as Extract<
      ClickHit,
      { kind: 'node' }
    >;
    expect(nodeHit.kind).toBe('node');
    expect(nodeHit.path).toEqual([1]);
    expect(nodeHit.fraction).toBe(0.5); // zero-width stub rect → the defined 0.5

    const sep = [...rendered.separators.keys()][0];
    expect(hitFromMouseEvent(fake(sep, 5), rendered)).toEqual({ kind: 'separator', path: [], index: 1 });

    const phRendered = buildMathML(fromJSON({ v: 1, root: { type: 'frac', num: null, den: num(2) } }), document);
    const phCaret: Caret = { kind: 'slot', path: [], slot: 'num' };
    const phEl = phRendered.placeholderByCaret.get(caretKey(phCaret))!;
    const phHit = hitFromMouseEvent(fake(phEl, 5), phRendered) as Extract<ClickHit, { kind: 'placeholder' }>;
    expect(phHit.caret).toEqual(phCaret);

    // no uid ancestor (the <math> element itself carries no id) → none hit
    expect(hitFromMouseEvent(fake(rendered.math, 5), rendered).kind).toBe('none');
  });

  it('toJSON round-trips the fixture envelopes used above (sanity)', () => {
    expect(toJSON(fromJSON(env)).root).toEqual(env.root);
  });
});
