// @vitest-environment jsdom
// Session-3 click work: in-token click targets (clicking within a number's
// glyph extent in a row places the in-token caret at the nearest character
// boundary), slot-edge click-to-exit (a click in a container's outer-edge zone
// places the caret at the nearest legal station OUTSIDE the parent — e.g. just
// right of a group's closing paren), the in-token caret overlay anchor, and a
// click→type merge integration. All with stubbed rects; placement never logs.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromJSON, type Envelope } from '../src/ast/index.js';
import type { Caret } from '../src/engine/index.js';
import { caretFromHit } from '../src/editor/click.js';
import { caretAnchor } from '../src/editor/caret-overlay.js';
import { EditorController } from '../src/editor/controller.js';
import { buildMathML } from '../src/editor/mathml-dom.js';
import { stubRects, type Rect, type RectStub } from './editor-support.js';

afterEach(() => vi.restoreAllMocks());

const sym = (name: string) => ({ type: 'sym', name }) as const;
const num = (value: number) => ({ type: 'num', value }) as const;

interface Fixture {
  controller: EditorController;
  container: HTMLDivElement;
  stub: RectStub;
  el: (path: string) => Element;
}

function fixture(envelope: unknown, byPath: Record<string, Rect>): Fixture {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  const stub = stubRects({ container: { left: 100, top: 50, width: 300, height: 40 } });
  stub.setMath({ left: 100, top: 50, width: 300, height: 40 });
  const controller = new EditorController(container, { envelope });
  stub.syncPath(controller.getRendered()!, byPath);
  controller.updateCaret();
  return { controller, container, stub, el: (path: string) => controller.getRendered()!.elementByPath.get(path)! };
}

const click = (el: Element, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX }));
};

const row = (index: number, path: (number | string)[] = []): Caret => ({ kind: 'row', path, index });
const node = (path: (number | string)[] = []): Caret => ({ kind: 'node', path });
const token = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path, index });

describe('in-token click targets (number glyph in a row)', () => {
  // add(12, b): row mrow [0,30), num cell [0,10), b [15,25)
  const env = { v: 1, root: { type: 'op', op: 'add', args: [num(12), sym('b')] } };
  const layout: Record<string, Rect> = {
    '[]': { left: 0, top: 0, width: 30, height: 10 },
    '[0]': { left: 0, top: 0, width: 10, height: 10 },
    '[1]': { left: 15, top: 0, width: 10, height: 10 },
  };
  const mk = () => fixture(env, layout);

  it('click x within the number’s extent → the in-token caret at the nearest character boundary', () => {
    const f = mk();
    click(f.el('[0]'), 2); // fraction 0.2 of len 2 → round(0.4) = 0
    expect(f.controller.getState().caret).toEqual(token([0], 0));
    click(f.el('[0]'), 7); // fraction 0.7 → round(1.4) = 1
    expect(f.controller.getState().caret).toEqual(token([0], 1));
    click(f.el('[0]'), 9); // fraction 0.9 → round(1.8) = 2 = len
    expect(f.controller.getState().caret).toEqual(token([0], 2));
    expect(f.controller.getState().log.length).toBe(0); // placement never logs
  });

  it('a symbol leaf clicks character-wise too (C1 nearest-edge, 4b-2 re-pin — was the row seam)', () => {
    const f = mk();
    click(f.el('[1]'), 17); // fraction 0.2 of b (len 1) → offset 0
    expect(f.controller.getState().caret).toEqual(token([1], 0));
    click(f.el('[1]'), 24); // fraction 0.9 → offset 1
    expect(f.controller.getState().caret).toEqual(token([1], 1));
  });

  it('click → type a digit merges at the clicked offset (one key = one op = one log entry)', () => {
    const f = mk();
    containerFocus(f.container);
    click(f.el('[0]'), 7); // token([0], 1) — between '1' and '2'
    expect(f.controller.getState().caret).toEqual(token([0], 1));
    press(f.container, '5');
    expect(JSON.stringify(f.controller.getEnvelope().root)).toBe(
      JSON.stringify({ type: 'op', op: 'add', args: [num(152), sym('b')] }),
    );
    expect(f.controller.getState().caret).toEqual(token([0], 2)); // caret advanced in-token
    expect(f.controller.getState().log.length).toBe(1);
  });

  it('caretFromHit pure pins: num-in-row → token caret; sym/num leaves → character-wise everywhere (4b-2 C1 re-pin, supersedes the slot/root node-caret pins)', () => {
    expect(caretFromHit(env as Envelope, { kind: 'node', path: [0], fraction: 0.25 })).toEqual(token([0], 1)); // round(0.5)=1... len 2 → round(0.25*2)=round(0.5)=1 (0.5 rounds up)
    expect(caretFromHit(env as Envelope, { kind: 'node', path: [0], fraction: 0.24 })).toEqual(token([0], 0));
    expect(caretFromHit(env as Envelope, { kind: 'node', path: [1], fraction: 0.9 })).toEqual(token([1], 1)); // sym leaf: offset len (C1)
    const slotEnv: Envelope = { v: 1, root: { type: 'frac', num: null, den: num(2) } };
    // slot leaf → character-wise in the slot's content (C1; the session-3 slot node-caret inconsistency is superseded)
    expect(caretFromHit(slotEnv, { kind: 'node', path: ['den'], fraction: 0.9 })).toEqual(token(['den'], 1));
    expect(caretFromHit(slotEnv, { kind: 'node', path: ['den'], fraction: 0.1 })).toEqual(token(['den'], 0));
    expect(caretFromHit({ v: 1, root: num(7) }, { kind: 'node', path: [], fraction: 0.9 })).toEqual(token([], 1)); // root leaf → in-token end
  });
});

describe('slot-edge click-to-exit (container outer-edge zone)', () => {
  // add((a+b), c): row [0,40), group mrow [0,20), c [25,35)
  const env = {
    v: 1,
    root: { type: 'op', op: 'add', args: [{ type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } }, sym('c')] },
  };
  const layout: Record<string, Rect> = {
    '[]': { left: 0, top: 0, width: 40, height: 10 },
    '[0]': { left: 0, top: 0, width: 20, height: 10 },
    '[0,"child"]': { left: 2, top: 0, width: 16, height: 10 },
    '[0,"child",0]': { left: 2, top: 0, width: 7, height: 10 },
    '[0,"child",1]': { left: 11, top: 0, width: 7, height: 10 },
    '[1]': { left: 25, top: 0, width: 10, height: 10 },
  };
  const mk = () => fixture(env, layout);

  it('a click in the group’s right outer-edge zone → the group’s own after-fence flank (4b-2 C1 re-pin: OA-fence-flank, the nearest station — not the next cell’s start)', () => {
    const f = mk();
    click(f.el('[0]'), 19); // fraction 0.95 ≥ 0.75 → the right edge zone → edgeStation, not exitStation
    // the after-`)` station node([0],'right') paints at the mrow's right edge — the nearest legal position (C1)
    expect(f.controller.getState().caret).toEqual({ kind: 'node', path: [0], side: 'right' });
    expect(f.controller.getState().log.length).toBe(0);
  });

  it('a click in the left outer-edge zone parks at the row’s start seam (no left content to rest in); middle clicks dive to the nearest flow end', () => {
    const f = mk();
    click(f.el('[0]'), 1); // fraction 0.05 ≤ 0.25 → exit left → the row’s border seam: before the group (amended session 4)
    expect(f.controller.getState().caret).toEqual(row(0));
    click(f.el('[0]'), 12); // fraction 0.6 → not an edge zone → dive right end
    // 4a re-pin (OA-visual-trumps): b's in-token end / a's in-token start
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0, 'child', 1], index: 1 });
    click(f.el('[0]'), 8); // fraction 0.4 → dive left end
    expect(f.controller.getState().caret).toEqual({ kind: 'token', path: [0, 'child', 0], index: 0 });
  });

  it('caretFromHit pure pins: edge zones → the container’s own edge station (edgeStation) first, exitStation only as fallback (4b-2 C1 re-pin)', () => {
    // nested group at cell 0: right edge → the group's own after-fence flank node([0],'right') (OA-fence-flank)
    expect(caretFromHit(env as Envelope, { kind: 'node', path: [0], fraction: 0.9 })).toEqual({ kind: 'node', path: [0], side: 'right' });
    expect(caretFromHit(env as Envelope, { kind: 'node', path: [0], fraction: 0.5 })).toEqual({ kind: 'token', path: [0, 'child', 1], index: 1 });
    // root container at 0.9: the row-root is not flankable — no edge station, no
    // outside → the dive; the bench end is b's in-token end
    const rowEnv: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };
    expect(caretFromHit(rowEnv, { kind: 'node', path: [], fraction: 0.9 })).toEqual({ kind: 'token', path: [1], index: 1 });
    // a nested op row inside a slot: rows are not flankable — no own edge
    // station, the click exits to the frac's border station node([],'right')
    // (4b-2: edgeStation defers to exitStation exactly like the engine's climb)
    const fracEnv: Envelope = {
      v: 1,
      root: { type: 'frac', num: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, den: sym('c') },
    };
    expect(caretFromHit(fracEnv, { kind: 'node', path: ['num'], fraction: 0.9 })).toEqual({ kind: 'node', path: [], side: 'right' });
    // a GROUP in a slot IS flankable: its edge zone resolves to the slot-boundary
    // flank node(['den'],'right') (OA-fence-flank), one spot inside the frac's border
    const grpEnv: Envelope = {
      v: 1,
      root: { type: 'frac', num: sym('a'), den: { type: 'group', parens: 'always', child: sym('b') } },
    };
    expect(caretFromHit(grpEnv, { kind: 'node', path: ['den'], fraction: 0.9 })).toEqual({ kind: 'node', path: ['den'], side: 'right' });
  });
});

describe('in-token caret overlay anchor (stubbed rects)', () => {
  it('token caret anchors at left + index/len of the number’s extent; the overlay div follows', () => {
    const env: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [num(123), sym('b')] } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    stub.syncPath(rendered, {
      '[0]': { left: 10, top: 5, width: 30, height: 12 },
    });
    expect(caretAnchor(env, token([0], 0), rendered)).toEqual({ x: 10, y: 5, height: 12 });
    expect(caretAnchor(env, token([0], 1), rendered)).toEqual({ x: 20, y: 5, height: 12 });
    expect(caretAnchor(env, token([0], 3), rendered)).toEqual({ x: 40, y: 5, height: 12 });
    // invalid token caret → null (caller hides the div)
    expect(caretAnchor(env, token([0], 4), rendered)).toBe(null);
  });

  it('the controller overlay div positions at the in-token anchor (container-relative)', () => {
    const container = document.createElement('div');
    container.id = 'container';
    document.body.appendChild(container);
    const stub = stubRects({ container: { left: 100, top: 50, width: 300, height: 40 } });
    stub.setMath({ left: 100, top: 50, width: 300, height: 40 });
    const env = { v: 1, root: { type: 'op', op: 'add', args: [num(12), sym('b')] } };
    const controller = new EditorController(container, { envelope: env });
    stub.syncPath(controller.getRendered()!, { '[0]': { left: 100, top: 52, width: 20, height: 10 } });
    controller.placeCaret(token([0], 1));
    const caretDiv = container.querySelector('.integral-caret') as HTMLElement;
    expect(caretDiv.style.left).toBe('10px'); // 100 + 1/2*20 − 100
    expect(caretDiv.style.top).toBe('2px');
    expect(caretDiv.style.height).toBe('10px');
    expect(caretDiv.style.display).toBe('block');
  });
});

// ——— small local key helpers (the full press() harness lives in editor-keyboard) ———

function containerFocus(container: HTMLElement): void {
  container.focus();
}

function press(container: HTMLElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  container.dispatchEvent(ev);
  return ev;
}
