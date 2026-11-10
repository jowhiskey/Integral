// MathML DOM builder for the editing view — browser-only (this subpath owns DOM).
//
// Architecture (decided): the editable view is structure-aware MathML. A plain-TS
// DOM builder mirrors the AST to MathML Core DOM; EVERY AST node gets exactly one
// element carrying a unique id (UID) — node identity for click mapping and later
// hover features. The emitted tags/text mirror the ratified toMathML() conventions
// exactly (upright mathvariant="normal" units, fence="true" mo pairs, <mi>□</mi>
// null-slot placeholders, ASCII /, Unicode −/×, slot wrappers), so the editing view
// cannot drift from the AST's string output — a parity test pins tags+text equality
// against the parsed toMathML(root) output.
//
// Full rebuild per state change (never surgical mutation — Blink does not reliably
// repaint after surgical MathML DOM changes): buildMathML produces a fresh <math>
// tree every call; the controller replaceChild's it.

import type { MathNode } from '../ast/nodes.js';
import {
  FunctionNode,
  GroupNode,
  NumberNode,
  OperatorNode,
  PowerNode,
  RootNode,
  FractionNode,
  SubscriptNode,
  SymbolNode,
  UNARY_OPS,
  UnitNode,
} from '../ast/nodes.js';

import type { Caret, Path, SlotName } from '../engine/caret.js';

export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** Visible empty-slot glyph (U+25A1) — same constant as the AST string renderer. */
export const EMPTY_SLOT_TEXT = '□';

/** mathjs fn name → displayed operator glyph. Mirrors the AST renderer's OP_DISPLAY
 *  (not exported from ./ast — zero AST changes); the parity pin catches drift. */
const OP_DISPLAY: Readonly<Record<string, string>> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '/',
  unaryMinus: '−',
  unaryPlus: '+',
  pow: '^',
  mod: 'mod',
};

/** Thin space between a unit's value and its symbol (~0.167em). */
const UNIT_SPACE_WIDTH = '0.1667em';

/** S-098 seam marker (styling-level): the classed mspace between two adjacent
 * number cells of an implicit-multiply row; the host's CSS paints it. The
 * carrier carries its own height/depth (mspace defaults to height 0 — a
 * plain background tint must have a box to paint) — mirrors the string
 * renderer's SEAM_MARKER bytes; the parity pin catches drift. */
const SEAM_CLASS = 'integral-seam';
const SEAM_WIDTH = '0.1667em';
const SEAM_HEIGHT = '0.75em';
const SEAM_DEPTH = '0.2em';

/**
 * A bare-cell caret anchor (an op-row null cell renders NO element — T7 split:
 * row-level missing operands are bare): the flanking separator glyph (which
 * edge) or, for glyph-less rows (all-null/operand-less), the row owner element
 * whose rect supplies x (a visible height comes from the <math> element).
 */
export interface BareAnchor {
  readonly glyphEl: Element | null;
  readonly side: 'left' | 'right';
  readonly rowEl: Element;
}

/** Stable map key for a path / caret (JSON of the step list / tagged union). */
export const pathKey = (path: Path): string => JSON.stringify(path);
export const caretKey = (caret: Caret): string => JSON.stringify(caret);

/** One rendered formula: the fresh <math> element plus the UID maps. */
export interface RenderedMath {
  /** The fresh <math> root element (empty when the formula is empty). */
  readonly math: Element;
  /** path key → uid (the id attribute of the node's own element). */
  readonly uidByPath: ReadonlyMap<string, string>;
  /** uid → path. */
  readonly pathByUid: ReadonlyMap<string, Path>;
  /** path key → the node's own element (carries the uid). */
  readonly elementByPath: ReadonlyMap<string, Element>;
  /** path key → [first, last] of the node's loose fragment (its rendered extent;
   *  differs from the own element for multi-element fragments like UnitNode). */
  readonly extents: ReadonlyMap<string, { readonly first: Element; readonly last: Element }>;
  /** <mi>□</mi> placeholder element → the caret it represents (a slot caret for a
   *  null fixed slot, a row caret for a null args cell). */
  readonly placeholders: ReadonlyMap<Element, Caret>;
  /** caret key → placeholder element (for caret anchoring). */
  readonly placeholderByCaret: ReadonlyMap<string, Element>;
  /** row separator <mo> element (operator glyphs, fn commas) → the seam it sits on. */
  readonly separators: ReadonlyMap<Element, { readonly path: Path; readonly index: number }>;
  /** 4b-1 (OA-seam-caret-height): seam key (`pathKey(rowPath)/index`) → the
   *  separator element rendered AT that boundary — the left-adjacent
   *  element whose height a seam station's caret paints at. */
  readonly separatorBySeam: ReadonlyMap<string, Element>;
  /** caret key → the bare-cell anchor (op-row null cells — no placeholder element). */
  readonly bareAnchors: ReadonlyMap<string, BareAnchor>;
  /** path key → a sub node's two label <mi> elements (T9: label token carets
   *  anchor within their own label element, not the msub extent). */
  readonly subLabels: ReadonlyMap<string, { readonly base: Element; readonly script: Element }>;
  /** THE FENCE ELEMENT MAP (rework session 3): every rendered fence glyph →
   *  its owning node + side. Covers the group/fn OPEN parens, the container
   *  CLOSE parens (rendered by the container itself — no uid of their own,
   *  which is exactly why D7/D8 needed an addressable map), and the dangling
   *  fence-node close tokens (C4, S-097). A `close: false` container renders
   *  NO close element — those containers appear in `fencesMissingClose`
   *  bound to their own container element (the missing-close state). */
  readonly fenceGlyphs: ReadonlyMap<Element, { readonly path: Path; readonly side: 'open' | 'close' }>;
  /** path key → the element of a group/fn whose close fence is absent
   *  (close: false — the movable-paren model's missing-close state). */
  readonly fencesMissingClose: ReadonlyMap<string, Element>;
  /** 4b-2 (C4): the fn NAME <mi> element → the fn's path — the head's name area
   *  is its own click target (the name carries no uid of its own; closest('[id]')
   *  would otherwise resolve it to the fn's mrow). */
  readonly fnHeads: ReadonlyMap<Element, Path>;
}

/** Module-level UID counter: ids stay unique across rebuilds and across trees
 *  built into the same document (full rebuild swaps the old tree out, but a
 *  document-wide unique id set keeps stale-element lookups impossible). */
let uidCounter = 0;

/**
 * Build the MathML DOM for `root` (null = empty formula → an empty <math> element).
 * Pure DOM construction: returns a fresh tree; nothing is attached to the document.
 */
export function buildMathML(root: MathNode | null, doc: Document): RenderedMath {
  const uidByPath = new Map<string, string>();
  const pathByUid = new Map<string, Path>();
  const elementByPath = new Map<string, Element>();
  const extents = new Map<string, { first: Element; last: Element }>();
  const placeholders = new Map<Element, Caret>();
  const placeholderByCaret = new Map<string, Element>();
  const separators = new Map<Element, { path: Path; index: number }>();
  const separatorBySeam = new Map<string, Element>();
  const bareAnchors = new Map<string, BareAnchor>();
  const subLabels = new Map<string, { base: Element; script: Element }>();
  const fenceGlyphs = new Map<Element, { path: Path; side: 'open' | 'close' }>();
  const fencesMissingClose = new Map<string, Element>();
  const fnHeads = new Map<Element, Path>();

  const el = (tag: string): Element => doc.createElementNS(MATHML_NS, tag);
  const mo = (text: string, fence: boolean): Element => {
    const m = el('mo');
    if (fence) m.setAttribute('fence', 'true');
    m.textContent = text;
    return m;
  };
  const placeholder = (caret: Caret): Element => {
    const mi = el('mi');
    mi.textContent = EMPTY_SLOT_TEXT;
    placeholders.set(mi, caret);
    placeholderByCaret.set(caretKey(caret), mi);
    return mi;
  };
  /** Register a node: stamp its own element with a fresh uid, record the maps. */
  const own = (path: Path, frag: Element[], ownEl: Element): Element[] => {
    const uid = `in-${uidCounter++}`;
    ownEl.setAttribute('id', uid);
    const key = pathKey(path);
    uidByPath.set(key, uid);
    pathByUid.set(uid, path);
    elementByPath.set(key, ownEl);
    extents.set(key, { first: frag[0], last: frag[frag.length - 1] });
    return frag;
  };

  // ——— fragments ———
  // A node's loose fragment: the elements its mathmlContent() would produce,
  // without any contextual wrapper. Slots/rows/root add the wrappers.

  /** childMathml: loose child in a fn args row. The FIRST argument cells
   *  are placeholder territory (T7/S-023 A: null → □ with a ROW caret); an
   *  empty argument beyond the first renders BARE at the fn case (the
   *  owner's B-23 live ruling), never through this helper. */
  const rowChild = (path: Path, index: number, child: MathNode | null): Element[] =>
    child === null
      ? [placeholder({ kind: 'row', path, index })]
      : fragment(child, [...path, index]);

  /** slotMathml: a fixed-arity slot child as ONE element (multi-element fragments
   *  wrapped in a single mrow). null → placeholder with a SLOT caret. */
  const slotChild = (path: Path, slot: SlotName, child: MathNode | null): Element =>
    child === null ? placeholder({ kind: 'slot', path, slot }) : wrapSlot(fragment(child, [...path, slot]));

  /** Anchor a bare op-row null cell after the row is fully built: the glyph
   *  before the cell wins (caret right after it), then the glyph after it
   *  (caret at its left edge), then the glyph-less fallback (the row owner's
   *  left edge; the <math> rect supplies a visible height). */
  const anchorBareCells = (
    path: Path,
    rowEl: Element,
    bareCells: number[],
    sepEls: (Element | undefined)[],
  ): void => {
    for (const i of bareCells) {
      const left = sepEls[i];
      const right = i + 1 < sepEls.length ? sepEls[i + 1] : undefined;
      bareAnchors.set(caretKey({ kind: 'row', path, index: i }), {
        glyphEl: left ?? right ?? null,
        side: left !== undefined ? 'right' : 'left',
        rowEl,
      });
    }
  };

  /** The op row tokens as loose elements — mirrors OperatorNode.rowTokens (the
   *  T7 split, live): a null cell renders BARE (no placeholder element); the
   *  separator glyphs disappear entirely on implicit multiply rows; the S-098
   *  forbidden number-number adjacency renders the classed seam mspace. */
  const rowTokens = (node: OperatorNode, path: Path, rowEl: Element): Element[] => {
    const display = OP_DISPLAY[node.op] ?? node.op;
    const args: (MathNode | null)[] = node.args;
    const sepEls: (Element | undefined)[] = [];
    const bareCells: number[] = [];
    const out: Element[] = [];
    args.forEach((arg, i) => {
      const prev = i > 0 ? args[i - 1] : null;
      if (node.implicit && i > 0 && prev !== null && arg !== null && prev.type === 'num' && arg.type === 'num') {
        const seam = el('mspace');
        seam.setAttribute('class', SEAM_CLASS);
        seam.setAttribute('width', SEAM_WIDTH);
        seam.setAttribute('height', SEAM_HEIGHT);
        seam.setAttribute('depth', SEAM_DEPTH);
        out.push(seam);
      }
      if (i > 0 && !node.implicit) {
        const sep = mo(display, false);
        separators.set(sep, { path, index: i });
    separatorBySeam.set(`${pathKey(path)}/${i}`, sep);
        sepEls[i] = sep;
        out.push(sep);
      }
      if (arg === null) bareCells.push(i);
      else out.push(...fragment(arg, [...path, i]));
    });
    anchorBareCells(path, rowEl, bareCells, sepEls);
    return out;
  };

  /** hostedChildMathml (GroupNode's fence row): a flat op row inlines loose,
   *  everything else renders as its loose fragment; null → placeholder slot caret.
   *  The inlined op has no mrow of its own (the string renderer inlines flatRow
   *  into the fence row — parity pins that), so the op's own uid element is the
   *  opening fence mo: every AST node still gets exactly one id-carrying element. */
  const hostedChild = (path: Path, child: MathNode | null, openFence: Element): Element[] => {
    if (child === null) return [placeholder({ kind: 'slot', path, slot: 'child' })];
    if (child instanceof OperatorNode && !UNARY_OPS.has(child.op) && !(child.op === 'pow' && child.args.length <= 2)) {
      const frag = rowTokens(child, [...path, 'child'], openFence);
      own([...path, 'child'], frag, openFence);
      return frag;
    }
    return fragment(child, [...path, 'child']);
  };

  /** The node's loose fragment; registers the node's uid/extent. */
  const fragment = (node: MathNode, path: Path): Element[] => {
    switch (node.type) {
      case 'num': {
        const mn = el('mn');
        mn.textContent = String((node as NumberNode).value) + ((node as NumberNode).dot ? '.' : '');
        return own(path, [mn], mn);
      }
      case 'sym': {
        const mi = el('mi');
        mi.textContent = (node as SymbolNode).name;
        return own(path, [mi], mi);
      }
      case 'op': {
        const op = node as OperatorNode;
        const display = OP_DISPLAY[op.op] ?? op.op;
        if (UNARY_OPS.has(op.op)) {
          // The unary glyph leads; a null cell renders BARE (T7 split) and
          // anchors at the lead glyph's right edge (never invisible).
          const mrow = el('mrow');
          const lead = mo(display, false);
          separators.set(lead, { path, index: 0 });
          separatorBySeam.set(`${pathKey(path)}/0`, lead);
          mrow.appendChild(lead);
          const sepEls: (Element | undefined)[] = [lead];
          const bareCells: number[] = [];
          op.args.forEach((arg, i) => {
            if (arg === null) {
              bareCells.push(i);
              return;
            }
            for (const f of fragment(arg, [...path, i])) mrow.appendChild(f);
          });
          anchorBareCells(path, mrow, bareCells, sepEls);
          return own(path, [mrow], mrow);
        }
        if (op.op === 'pow' && op.args.length <= 2) {
          // ≤2-arg pow op renders like PowerNode (msup); null args are row cells
          // (an op has no named slots), wrapped like slotMathml when multi-element.
          // Power slots are placeholder territory (T7 — □ in the exponent).
          const msup = el('msup');
          const args: (MathNode | null)[] = [op.args[0] ?? null, op.args[1] ?? null];
          args.forEach((arg, i) => {
            msup.appendChild(
              arg === null ? placeholder({ kind: 'row', path, index: i }) : wrapSlot(fragment(arg, [...path, i])),
            );
          });
          return own(path, [msup], msup);
        }
        const mrow = el('mrow');
        for (const f of rowTokens(op, path, mrow)) mrow.appendChild(f);
        return own(path, [mrow], mrow);
      }
      case 'fn': {
        const fn = node as FunctionNode;
        const mrow = el('mrow');
        const name = el('mi');
        name.textContent = fn.name;
        fnHeads.set(name, path);
        mrow.appendChild(name);
        const open = mo('(', true);
        fenceGlyphs.set(open, { path, side: 'open' });
        mrow.appendChild(open);
        // An empty argument BEYOND the first renders BARE — no placeholder
        // (the owner's B-23 live ruling: the trailing comma carries the
        // state, the caret anchors at it like a bare op-row cell); the FIRST
        // argument keeps its □ (T7/S-023 A).
        const sepEls: (Element | undefined)[] = [];
        const bareCells: number[] = [];
        fn.args.forEach((arg, i) => {
          if (i > 0) {
            const comma = mo(',', false);
            separators.set(comma, { path, index: i });
            separatorBySeam.set(`${pathKey(path)}/${i}`, comma);
            sepEls[i] = comma;
            mrow.appendChild(comma);
            if (arg === null) bareCells.push(i);
          }
          if (arg !== null || i === 0) {
            for (const f of rowChild(path, i, arg)) mrow.appendChild(f);
          }
        });
        anchorBareCells(path, mrow, bareCells, sepEls);
        // close = false: the movable closing fence is absent — the row stands
        // open (the missing-close state stays addressable through the map).
        if (fn.close) {
          const close = mo(')', true);
          fenceGlyphs.set(close, { path, side: 'close' });
          mrow.appendChild(close);
        } else {
          fencesMissingClose.set(pathKey(path), mrow);
        }
        return own(path, [mrow], mrow);
      }
      case 'fence': {
        // A movable close-fence glyph token (dangling or paired): one fenced mo.
        const f = el('mo');
        f.setAttribute('fence', 'true');
        f.textContent = ')';
        fenceGlyphs.set(f, { path, side: 'close' });
        return own(path, [f], f);
      }
      case 'group': {
        const group = node as GroupNode;
        const mrow = el('mrow');
        const openFence = mo('(', true);
        fenceGlyphs.set(openFence, { path, side: 'open' });
        mrow.appendChild(openFence);
        for (const f of hostedChild(path, group.child, openFence)) mrow.appendChild(f);
        // close = false: see the fn case.
        if (group.close) {
          const close = mo(')', true);
          fenceGlyphs.set(close, { path, side: 'close' });
          mrow.appendChild(close);
        } else {
          fencesMissingClose.set(pathKey(path), mrow);
        }
        return own(path, [mrow], mrow);
      }
      case 'frac': {
        const frac = node as FractionNode;
        const mfrac = el('mfrac');
        mfrac.appendChild(slotChild(path, 'num', frac.num));
        mfrac.appendChild(slotChild(path, 'den', frac.den));
        return own(path, [mfrac], mfrac);
      }
      case 'pow': {
        const pow = node as PowerNode;
        const msup = el('msup');
        msup.appendChild(slotChild(path, 'base', pow.base));
        msup.appendChild(slotChild(path, 'exp', pow.exp));
        return own(path, [msup], msup);
      }
      case 'root': {
        const root = node as RootNode;
        // mroot keeps the mroot form with a placeholder index even when the
        // index slot is empty (T7 □-territory); without it a null index is
        // the complete v1 square root.
        if (root.index === null && !root.mroot) {
          const msqrt = el('msqrt');
          msqrt.appendChild(slotChild(path, 'radicand', root.radicand));
          return own(path, [msqrt], msqrt);
        }
        const mroot = el('mroot');
        mroot.appendChild(slotChild(path, 'radicand', root.radicand));
        mroot.appendChild(slotChild(path, 'index', root.index));
        return own(path, [mroot], mroot);
      }
      case 'sub': {
        const sub = node as SubscriptNode;
        const msub = el('msub');
        const base = el('mi');
        base.textContent = sub.base;
        const script = el('mi');
        // An empty script label carries the standing □ affordance (the
        // owner's rework-session-3 live note, B-19 — parity with the AST
        // renderer and the power's exponent slot).
        script.textContent = sub.sub === '' ? EMPTY_SLOT_TEXT : sub.sub;
        msub.appendChild(base);
        msub.appendChild(script);
        subLabels.set(pathKey(path), { base, script });
        return own(path, [msub], msub);
      }
      case 'unit': {
        const unit = node as UnitNode;
        const frag: Element[] = [];
        // childMathml in a row/root context: null value → placeholder with a
        // slot caret on the unit's own 'value' slot.
        if (unit.value === null) {
          frag.push(placeholder({ kind: 'slot', path, slot: 'value' }));
        } else {
          frag.push(...fragment(unit.value, [...path, 'value']));
        }
        const label = el('mi');
        label.setAttribute('mathvariant', 'normal');
        if (unit.unit === '') {
          // empty unit string: no separator, empty upright mi
          frag.push(label);
        } else {
          const space = el('mspace');
          space.setAttribute('width', UNIT_SPACE_WIDTH);
          label.textContent = unit.unit;
          frag.push(space, label);
        }
        // The unit's own element is its upright symbol mi (the value is a child
        // node with its own element); the extent spans the whole fragment.
        return own(path, frag, label);
      }
    }
  };

  /** slotMathml's single-element wrap for a fragment. */
  const wrapSlot = (frag: Element[]): Element => {
    if (frag.length === 1) return frag[0];
    const mrow = el('mrow');
    for (const f of frag) mrow.appendChild(f);
    return mrow;
  };

  const math = el('math');
  if (root !== null) {
    const frag = fragment(root, []);
    if (frag.length === 1) {
      math.appendChild(frag[0]);
    } else {
      const mrow = el('mrow');
      for (const f of frag) mrow.appendChild(f);
      math.appendChild(mrow);
    }
  }

  return { math, uidByPath, pathByUid, elementByPath, extents, placeholders, placeholderByCaret, separators, separatorBySeam, bareAnchors, subLabels, fenceGlyphs, fencesMissingClose, fnHeads };
}
