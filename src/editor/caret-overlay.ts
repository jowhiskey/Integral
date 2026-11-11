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
//                    typed syms rest in-token, OA-token-end). The UNIT SEAM
//                    (the label's offset 0 and the value's end, the seam's
//                    twin states) paints MID-WAY between value and label
//                    (OA-unit-seam-paint, I-22).

import type { Envelope } from '../ast/json.js';

import { isRowNode, nodeAt, rowArgs, tokenText, type Caret, type Path } from '../engine/caret.js';

import { caretKey, pathKey, type RenderedMath } from './mathml-dom.js';

/** A pixel anchor for the caret div: left edge, top, height. */
export interface CaretAnchor {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/** OA-after-structure-shift (ruled live 2026-11-10, the M-18 case): the
 *  after-structure station's overlay anchor shifts a small distance to the
 *  right, so it stays visually distinguishable from the structure's inner
 *  content end sharing the same horizontal space. Overlay anchor rule only —
 *  no engine state change. */
export const AFTER_STRUCTURE_SHIFT_PX = 2;

// ——— OA-seam-caret-height (rework 4b-1) ———
//
// The seam-station anchor rule, as a PURE selection from (state + tree):
// a seam station's caret paints at the HEIGHT of its LEFT-ADJACENT
// element — the separator glyph for a flank/pending station at a glyph
// zone ("normal text height behind the +"; explicitly unwanted: a caret
// as tall as the fraction while standing LEFT of it), the last cell for
// the end-of-row seam (`1+1/2|` → the fraction's full height). Fallback
// with no left neighbor (the row start, a bare root): the CURRENT
// element's height (the prototype's offset-0-of-current exception — a
// row starting with a fraction paints the caret at fraction height).

import { NAV_PROFILES, type NavRegistry } from '../engine/index.js';
import { refOfPath } from '../engine/caret.js';

/** The element a seam station's caret takes its height from (the pure
 *  rule; the x coordinate stays the station's own geometry). */
export type SeamAnchorSpec =
  | { readonly kind: 'separator'; readonly rowPath: Path; readonly index: number }
  | { readonly kind: 'element'; readonly path: Path };

/** True iff the node's own left/right edge is a station state (`side`). */
const hasSide = (env: Envelope, caret: Caret): caret is Extract<Caret, { kind: 'node' }> & { side: 'left' | 'right' } =>
  caret.kind === 'node' && caret.side !== undefined;

/** The seam-anchor selection (seam state + tree → anchor element path):
 *  the left-adjacent separator when the station's boundary carries one,
 *  else the current element (the 4b-1 fallback rule). Row seams anchor
 *  per the 4a collapse rules: the end seam rides the last cell's extent,
 *  the start seam and bare cells ride the current element. */
export function seamAnchorSpec(env: Envelope, caret: Caret, registry: NavRegistry = NAV_PROFILES): SeamAnchorSpec | null {
  if (caret.kind === 'empty') return null;
  if (hasSide(env, caret)) {
    if (caret.side === 'right') return { kind: 'element', path: caret.path };
    const ref = refOfPath(caret.path);
    if (ref.at === 'cell') return { kind: 'separator', rowPath: ref.path, index: ref.index };
    return { kind: 'element', path: caret.path }; // no left neighbor: the current element
  }
  if (caret.kind === 'row') {
    const row = nodeAt(env, caret.path);
    if (row === null || !isRowNode(row)) return null;
    const args = rowArgs(row);
    if (caret.index >= args.length) {
      return args.length > 0 && args[args.length - 1] !== null
        ? { kind: 'element', path: [...caret.path, args.length - 1] } // the end seam: the last cell's extent (left-adjacent)
        : { kind: 'element', path: caret.path };
    }
    if (args[caret.index] === null) {
      return { kind: 'separator', rowPath: caret.path, index: caret.index }; // the bare anchor: the left glyph first
    }
    // 4b-2 amendment to OA-seam-caret-height (K-07, ruled live 2026-11-10) +
    // M-15 #5: an INTERIOR row seam with a separator glyph on its left
    // anchors at that glyph (its height; the overlay puts x at its right
    // edge) — never the following cell's full extent (a caret as tall as the
    // fraction while standing LEFT of it at the flank's x is the ruled-out
    // shape).
    if (caret.index > 0 && ((row.type === 'op' && (row as { implicit?: boolean }).implicit !== true) || row.type === 'fn')) {
      return { kind: 'separator', rowPath: caret.path, index: caret.index };
    }
    return { kind: 'element', path: [...caret.path, caret.index] }; // the row start: the current element (the offset-0-of-current exception)
  }
  return null;
}

/** Resolve the spec against the rendered maps (the anchor element only —
 *  the caller projects its rect onto the caret's own x). */
function seamAnchorElement(caret: Caret, spec: SeamAnchorSpec | null, rendered: RenderedMath): Element | null {
  if (spec === null) return null;
  if (spec.kind === 'separator') {
    return rendered.separatorBySeam.get(`${pathKey(spec.rowPath)}/${spec.index}`) ?? null;
  }
  void caret;
  return rendered.elementByPath.get(pathKey(spec.path)) ?? null;
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

/** OA-unit-seam-paint (I-22, ruled live 2026-11-10, cleanup-session live
 *  check): the unit-seam caret paints MID-WAY between the value's right edge
 *  and the label's left edge (equal spacing) — the owner's preferred
 *  position, applied consistently to BOTH seam states (the label's offset 0
 *  and the value's end, the seam's twin). Overlay anchor choice only — no
 *  engine state change. Null when either side has no rendered element (a
 *  valueless unit keeps the plain label anchor). */
function unitSeamMidX(rendered: RenderedMath, unitPath: Path): number | null {
  const valueRect = extentRect(rendered, [...unitPath, 'value']);
  const labelEl = rendered.elementByPath.get(pathKey(unitPath));
  if (valueRect === null || labelEl === undefined) return null;
  const labelRect = rectOf(labelEl);
  return (valueRect.right + labelRect.left) / 2;
}

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
      // after-station (the extent's right edge — the spot D5 fires from),
      // painted with OA-after-structure-shift's small right shift.
      if (caret.side === 'right') return { x: r.right + AFTER_STRUCTURE_SHIFT_PX, y: r.top, height: r.height };
      // 4b-1 OA-seam-caret-height: the LEFT flank paints at its
      // LEFT-ADJACENT element's height (the separator glyph in a glyph
      // zone, e.g. normal text height behind the `+`); without one (the
      // row start, a bare root) the current element's full height (the
      // offset-0-of-current exception).
      if (caret.side === 'left') {
        const anchorEl = seamAnchorElement(caret, seamAnchorSpec(env, caret), rendered);
        if (anchorEl !== null) {
          const g = rectOf(anchorEl);
          return { x: r.left, y: g.top, height: g.height };
        }
        return { x: r.left, y: r.top, height: r.height };
      }
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
        if (r === null) return null;
        // K-07 / M-15 #5: an interior seam with a separator glyph on its left
        // anchors at the glyph — x at its RIGHT edge (the after-glyph spot,
        // not touching the right neighbor), y/height at the glyph's rect —
        // never the following cell's full extent.
        const spec = seamAnchorSpec(env, caret);
        if (spec !== null && spec.kind === 'separator') {
          const g = seamAnchorElement(caret, spec, rendered);
          if (g !== null) {
            const gr = rectOf(g);
            return { x: gr.right, y: gr.top, height: gr.height };
          }
        }
        return { x: r.left, y: r.top, height: r.height };
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
      // OA-unit-seam-paint (I-22): the unit seam's two states — the label's
      // offset 0 and the value's end (a token caret on the unit's 'value'
      // slot) — both anchor at the midway x between value and label.
      {
        const lastStep = caret.path[caret.path.length - 1];
        const unitPath: Path | null =
          node.type === 'unit' && caret.index === 0 && len > 0
            ? caret.path
            : node.type !== 'unit' && caret.index === len && lastStep === 'value'
              ? caret.path.slice(0, -1)
              : null;
        if (unitPath !== null && nodeAt(env, unitPath)?.type === 'unit') {
          const mid = unitSeamMidX(rendered, unitPath);
          if (mid !== null) return { x: mid, y: rect.top, height: rect.height };
        }
      }
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
