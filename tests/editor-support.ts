// Shared helpers for the editor (DOM-layer) tests: the rect-stub pattern.
// jsdom has no layout — every getBoundingClientRect is stubbed. Rects are assigned
// per element, and re-synced from a rendered tree by PATH key (rebuilds create
// fresh elements with fresh uids, so path-keyed sync survives replaceChild).

import { vi } from 'vitest';

import type { RenderedMath } from '../src/editor/mathml-dom.js';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const asDomRect = (r: Rect): DOMRect =>
  ({
    x: r.left,
    y: r.top,
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    toJSON: () => ({}),
  }) as DOMRect;

const ZERO: Rect = { left: 0, top: 0, width: 0, height: 0 };

/** Stub for Element.prototype.getBoundingClientRect, rects keyed by element id. */
export interface RectStub {
  /** Assign a rect to one element (by its current id). */
  set(el: Element, r: Rect): void;
  /** Assign rects by path key ('[]', '[0]', '["num"]', …) to the rendered tree's elements. */
  syncPath(rendered: RenderedMath, byPath: Record<string, Rect>): void;
  /** Assign rects by caret key (JSON of the caret) to the rendered placeholders. */
  syncCaret(rendered: RenderedMath, byCaret: Record<string, Rect>): void;
  /** Rect of the rendered <math> element (it carries no id). */
  setMath(r: Rect): void;
}

export function stubRects(byId: Record<string, Rect> = {}): RectStub {
  const rects: Record<string, Rect> = { ...byId };
  // id-less elements (placeholders, the <math> element) are keyed by instance
  const byEl = new WeakMap<Element, Rect>();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = byEl.get(this) ?? (this.id !== '' ? rects[this.id] : this.localName === 'math' ? rects['<math>'] : undefined);
    return asDomRect(r ?? ZERO);
  });
  return {
    set: (el, r) => {
      byEl.set(el, r);
    },
    syncPath: (rendered, byPath) => {
      for (const [key, r] of Object.entries(byPath)) {
        const el = rendered.elementByPath.get(key);
        if (el) byEl.set(el, r);
      }
    },
    syncCaret: (rendered, byCaret) => {
      for (const [key, r] of Object.entries(byCaret)) {
        const el = rendered.placeholderByCaret.get(key);
        if (el) byEl.set(el, r);
      }
    },
    setMath: (r) => {
      rects['<math>'] = r;
    },
  };
}

/** Tag+text shape of a DOM subtree — attributes ignored (the editor adds ids). */
export const shape = (node: Node): string => {
  if (node.nodeType === 3) return `#${node.textContent ?? ''}`;
  const el = node as Element;
  const kids = [...el.childNodes].map(shape).join('');
  return `<${el.localName}>${kids}</${el.localName}>`;
};

/** Count the AST nodes in an envelope root (NodeJson). */
export function countNodes(node: unknown): number {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 0;
  const n = node as Record<string, unknown>;
  let count = 1;
  for (const key of ['args', 'child', 'num', 'den', 'base', 'exp', 'radicand', 'index', 'value'] as const) {
    const v = n[key];
    if (Array.isArray(v)) count += v.reduce((acc, a) => acc + countNodes(a), 0);
    else count += countNodes(v);
  }
  return count;
}
