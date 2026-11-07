// Caret overlay — browser-only. The caret is NEVER inside the MathML: an
// absolutely-positioned blinking div over the editor container, anchored from
// getBoundingClientRect() of the UID-mapped elements (Range rects are reserved for
// in-token positions, a later session).
//
// Anchor per caret kind (all coordinates in the same space as the rects, i.e.
// page/client coordinates; updateCaretOverlay re-bases them onto the container):
// - empty          → left edge of the <math> element (the empty formula's caret).
// - node           → left edge of the node's rendered extent (first..last fragment).
// - slot           → left edge of the <mi>□</mi> placeholder element.
// - row, index < n → left edge of cell index's extent (or its □ placeholder).
// - row, index = n → right edge of the last cell's extent (row owner's left edge
//                    when the row is empty).

import type { Envelope } from '../ast/json.js';

import { isRowNode, nodeAt, rowArgs, type Caret, type Path } from '../engine/caret.js';

import { caretKey, pathKey, type RenderedMath } from './mathml-dom.js';

/** A pixel anchor for the caret div: left edge, top, height. */
export interface CaretAnchor {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly height: number;
}

const rectOf = (e: Element): RectLike => e.getBoundingClientRect();

/** The extent rect of a node path: union of its first/last fragment element rects. */
const extentRect = (rendered: RenderedMath, path: Path): RectLike | null => {
  const ext = rendered.extents.get(pathKey(path));
  if (!ext) return null;
  const a = rectOf(ext.first);
  const b = rectOf(ext.last);
  const top = Math.min(a.top, b.top);
  const bottom = Math.max(a.bottom, b.bottom);
  return { left: a.left, top, right: b.right, bottom, height: bottom - top };
};

/**
 * Pixel anchor for a caret in a rendered tree. Returns null when the caret does
 * not resolve against the rendered maps (should not happen for engine-valid
 * carets — the caller then hides the caret div).
 */
export function caretAnchor(env: Envelope, caret: Caret, rendered: RenderedMath): CaretAnchor | null {
  switch (caret.kind) {
    case 'empty': {
      const r = rectOf(rendered.math);
      return { x: r.left, y: r.top, height: r.height };
    }
    case 'node': {
      const r = extentRect(rendered, caret.path);
      return r === null ? null : { x: r.left, y: r.top, height: r.height };
    }
    case 'slot': {
      const ph = rendered.placeholderByCaret.get(caretKey(caret));
      if (!ph) return null;
      const r = rectOf(ph);
      return { x: r.left, y: r.top, height: r.height };
    }
    case 'row': {
      const row = nodeAt(env, caret.path);
      if (row === null || !isRowNode(row)) return null;
      const args = rowArgs(row);
      if (caret.index < args.length) {
        if (args[caret.index] === null) {
          const ph = rendered.placeholderByCaret.get(caretKey({ kind: 'row', path: caret.path, index: caret.index }));
          if (!ph) return null;
          const r = rectOf(ph);
          return { x: r.left, y: r.top, height: r.height };
        }
        const r = extentRect(rendered, [...caret.path, caret.index]);
        return r === null ? null : { x: r.left, y: r.top, height: r.height };
      }
      // the seam after the last cell
      if (args.length === 0) {
        const owner = rendered.elementByPath.get(pathKey(caret.path));
        if (!owner) return null;
        const r = rectOf(owner);
        return { x: r.left, y: r.top, height: r.height };
      }
      const r = extentRect(rendered, [...caret.path, args.length - 1]);
      return r === null ? null : { x: r.right, y: r.top, height: r.height };
    }
  }
}

/**
 * Position the overlay caret div for the current state. The div is absolutely
 * positioned inside the (position:relative) container; coordinates are re-based
 * from client space onto the container's rect. A null anchor hides the div.
 */
export function updateCaretOverlay(
  caretDiv: HTMLElement,
  container: HTMLElement,
  env: Envelope,
  caret: Caret,
  rendered: RenderedMath,
): void {
  const anchor = caretAnchor(env, caret, rendered);
  if (anchor === null) {
    caretDiv.style.display = 'none';
    return;
  }
  const cr = container.getBoundingClientRect();
  caretDiv.style.display = 'block';
  caretDiv.style.left = `${anchor.x - cr.left}px`;
  caretDiv.style.top = `${anchor.y - cr.top}px`;
  caretDiv.style.height = `${anchor.height}px`;
}
