// Caret overlay — browser-only. The caret is NEVER inside the MathML: an
// absolutely-positioned blinking div over the editor container, anchored from
// getBoundingClientRect() of the UID-mapped elements. In-token positions
// interpolate linearly over the number's extent rect (per-glyph Range rects
// remain a possible refinement).
//
// Anchor per caret kind (all coordinates in the same space as the rects, i.e.
// page/client coordinates; updateCaretOverlay re-bases them onto the container):
// - empty          → left edge of the <math> element (the empty formula's caret).
// - node           → left edge of the node's rendered extent (first..last fragment);
//                    a `side: 'right'` border station (4a) anchors at the extent's
//                    RIGHT edge (the whole-structure after-station).
// - slot           → left edge of the <mi>□</mi> placeholder element.
// - row, index < n → left edge of cell index's extent; a placeholder cell at its
//                    □; a BARE op-row cell at the flanking separator glyph's edge
//                    (preceding glyph's right edge, then the following glyph's
//                    left edge; glyph-less rows anchor at the row owner with the
//                    <math> height — the caret is never invisible).
// - row, index = n → right edge of the last cell's extent (row owner's left edge
//                    when the row is empty).
// - token, index  → the character boundary inside the token's rect (left
//                    edge + index/len of the width): a sub label (T9) within
//                    its own label element, a unit label (S-104) within the
//                    unit's own element — the upright label mi; numbers and
//                    symbols interpolate over their own extent (rework 4a —
//                    typed syms rest in-token, OA-token-end).

import type { Envelope } from '../ast/json.js';

import { isRowNode, nodeAt, rowArgs, tokenText, type Caret, type Path } from '../engine/caret.js';

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
      if (r === null) return null;
      // The 4a border stations: side 'right' is the whole-structure
      // after-station (the extent's right edge — the spot D5 fires from).
      if (caret.side === 'right') return { x: r.right, y: r.top, height: r.height };
      return { x: r.left, y: r.top, height: r.height };
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
          // Placeholder cells (fn args, power-op slots) anchor at the □;
          // BARE op-row cells have no element — anchor at the flanking
          // separator glyph's edge (the anchor fallback, S-023/T7 split).
          const ph = rendered.placeholderByCaret.get(caretKey({ kind: 'row', path: caret.path, index: caret.index }));
          if (ph) {
            const r = rectOf(ph);
            return { x: r.left, y: r.top, height: r.height };
          }
          const bare = rendered.bareAnchors.get(caretKey({ kind: 'row', path: caret.path, index: caret.index }));
          if (bare) {
            if (bare.glyphEl !== null) {
              const r = rectOf(bare.glyphEl);
              return { x: bare.side === 'right' ? r.right : r.left, y: r.top, height: r.height };
            }
            // Glyph-less row (all-null/operand-less): the row owner's left
            // edge; the <math> rect supplies a visible height.
            const rowR = rectOf(bare.rowEl);
            const mathR = rectOf(rendered.math);
            return { x: rowR.left, y: mathR.top, height: mathR.height };
          }
          return null;
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
    case 'token': {
      // in-token: the character boundary within the token's rect, linearly
      // interpolated (glyph metrics are reserved for a later session; the
      // extent is the stubbed-rect-testable anchor).
      const node = nodeAt(env, caret.path);
      if (node === null) return null;
      // A sub label (T9) interpolates within its OWN label element; a unit
      // label (S-104) within the unit's own element — the upright label mi;
      // numbers interpolate over the node's extent like before.
      let rect: RectLike | null = null;
      let len = 0;
      if (node.type === 'sub') {
        if (caret.label !== 'base' && caret.label !== 'sub') return null;
        const labels = rendered.subLabels.get(pathKey(caret.path));
        if (labels === undefined) return null;
        const el = caret.label === 'base' ? labels.base : labels.script;
        rect = rectOf(el);
        len = (caret.label === 'base' ? node.base : node.sub).length;
      } else if (node.type === 'unit') {
        if (caret.label !== undefined) return null;
        const el = rendered.elementByPath.get(pathKey(caret.path));
        if (el === undefined) return null;
        rect = rectOf(el);
        len = node.unit.length;
      } else if (node.type === 'num' || node.type === 'sym') {
        if (caret.label !== undefined) return null;
        // Rework 4a: symbols interpolate over their own extent like numbers
        // (typed syms rest in-token per OA-token-end).
        rect = extentRect(rendered, caret.path);
        len = tokenText(node).length;
      } else {
        return null;
      }
      if (rect === null) return null;
      if (!Number.isInteger(caret.index) || caret.index < 0 || caret.index > len) return null;
      const x = len === 0 ? rect.left : rect.left + (caret.index / len) * (rect.right - rect.left);
      return { x, y: rect.top, height: rect.height };
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
