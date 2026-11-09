// @vitest-environment jsdom
// End-of-node positions at the DOM layer (session-4 fix arc): the keyboard
// path types multi-digit numbers (12/3 from an empty editor), arrow overflow
// parks at the row-end seam, background/edge-zone clicks place the seam, and
// the delete-then-continue recovery flow (x+y, Backspace, +, z) works through
// the controller end to end. One key = one op = one log entry throughout.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects, type Rect } from './editor-support.js';
import { envelopeOf, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const j = (x: unknown): string => JSON.stringify(x);

function make(envelope: unknown, byPath: Record<string, Rect> = {}): {
  controller: EditorController;
  container: HTMLDivElement;
  el: (path: string) => Element;
} {
  const container = document.createElement('div');
  container.id = 'eon';
  document.body.appendChild(container);
  const stub = stubRects({ eon: { left: 100, top: 50, width: 300, height: 40 } });
  stub.setMath({ left: 100, top: 50, width: 300, height: 40 });
  const controller = new EditorController(container, { envelope });
  stub.syncPath(controller.getRendered()!, byPath);
  controller.updateCaret();
  container.focus();
  return { controller, container, el: (p) => controller.getRendered()!.elementByPath.get(p)! };
}

function press(container: HTMLElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  container.dispatchEvent(ev);
  return ev;
}

const click = (el: Element, clientX: number): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX }));
};

describe('keyboard: multi-digit typing through the controller', () => {
  it('12/3 from an empty editor: each key one op, final caret on the denominator', () => {
    const { controller, container } = make(undefined);
    for (const key of ['1', '2', '/', '3']) press(container, key);
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'frac', num: num(12), den: num(3) }),
    );
    expect(j(controller.getState().caret)).toBe(j(node(['den'])));
    expect(controller.getState().log.length).toBe(4); // one key = one op = one log entry
  });

  it('a digit at the end seam after a symbol joins the name (digit-glue, owner amendment)', () => {
    const { controller, container } = make({
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
    });
    controller.placeCaret(rowc([], 2));
    const ev = press(container, '3');
    expect(ev.defaultPrevented).toBe(true);
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), sym('y3')] }),
    );
    expect(j(controller.getState().caret)).toBe(j(rowc([], 2))); // the seam survives the replace
    expect(controller.getState().log.length).toBe(1);
  });
});

describe('keyboard: arrow overflow parks at the row-end seam', () => {
  const xFrac = {
    v: 1,
    root: {
      type: 'op',
      op: 'add',
      args: [sym('x'), { type: 'frac', num: sym('a'), den: sym('b') }],
    },
  };

  it('Right out of the last fraction parks after it; a further Right is a no movement', () => {
    const { controller, container } = make(xFrac);
    controller.placeCaret(node([1, 'den']));
    press(container, 'ArrowRight');
    expect(j(controller.getState().caret)).toBe(j(rowc([], 2)));
    expect(controller.getState().log.length).toBe(0); // movement never logs
    const before = controller.getState();
    press(container, 'ArrowRight');
    expect(controller.getState()).toBe(before); // the seam is the terminal station
  });
});

describe('keyboard: the delete-then-continue recovery flow', () => {
  it('x+y, Backspace (D1: y empties → the cell becomes the pending null), z — the dangling glyph chains on (rework session 3 re-pin of D1: a token that empties leaves the PENDING NULL, never splices the glyph away)', () => {
    const { controller, container } = make({
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
    });
    controller.placeCaret(node([1]));
    press(container, 'Backspace');
    // D1: the single-char y dies → the cell is the pending null (the + survives
    // as the dangling glyph); the freed spot is the caret sitting in it.
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), null] }),
    );
    expect(j(controller.getState().caret)).toBe(j(rowc([], 1)));
    press(container, 'z'); // the dangling glyph's operand fills directly — no retype needed
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), sym('z')] }),
    );
    expect(j(controller.getState().caret)).toBe(j(node([1])));
    expect(controller.getState().log.length).toBe(2); // delete, fill
  });

  it('typing + at the post-delete pending cell doubles the glyph (the same-op chain: x+, then + again → x++)', () => {
    const { controller, container } = make({
      v: 1,
      root: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
    });
    controller.placeCaret(node([1]));
    press(container, 'Backspace');
    press(container, '+');
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('x'), null, null] }),
    ); // T1 alongside: the dangling + keeps its pending cell, the typed + adds its own
    expect(controller.getState().log.length).toBe(2); // delete, extend
  });
});

describe('click: the row-end seam is placeable', () => {
  const xFrac = {
    v: 1,
    root: {
      type: 'op',
      op: 'add',
      args: [sym('x'), { type: 'frac', num: sym('a'), den: sym('b') }],
    },
  };
  // row [100,150) at 100: x [100,110), frac [120,145), math root [100,130)
  const layout: Record<string, Rect> = {
    '[]': { left: 100, top: 50, width: 50, height: 40 },
    '[0]': { left: 100, top: 50, width: 10, height: 40 },
    '[1]': { left: 120, top: 50, width: 25, height: 40 },
  };

  it('a click in the last fraction’s right edge zone parks at the end seam (no dive)', () => {
    const { controller, el } = make(xFrac, layout);
    click(el('[1]'), 144); // fraction (144-120)/25 = 0.96 → exit right → the end seam
    expect(j(controller.getState().caret)).toBe(j(rowc([], 2)));
    expect(controller.getState().log.length).toBe(0); // placement never logs
  });

  it('a background click beyond the row content parks at start/end seams; mid gaps keep the dive', () => {
    const { controller } = make(xFrac, layout);
    const math = controller.getRendered()!.math; // the <math> element carries no uid → a none hit
    click(math, 110); // fraction (110-100)/300 ≈ 0.033 ≤ 0.25 → the start seam
    expect(j(controller.getState().caret)).toBe(j(rowc([], 0)));
    click(math, 250); // fraction 0.5 — the middle zone: not < 0.5, so the right side: enter at the right flow end
    expect(j(controller.getState().caret)).toBe(j(node([1, 'den'])));
    click(math, 390); // fraction (390-100)/300 ≈ 0.967 ≥ 0.75 → the end seam
    expect(j(controller.getState().caret)).toBe(j(rowc([], 2)));
  });
});
