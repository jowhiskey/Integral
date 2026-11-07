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

  /** childMathml: loose child in a row (null → placeholder with a ROW caret). */
  const rowChild = (path: Path, index: number, child: MathNode | null): Element[] =>
    child === null
      ? [placeholder({ kind: 'row', path, index })]
      : fragment(child, [...path, index]);

  /** slotMathml: a fixed-arity slot child as ONE element (multi-element fragments
   *  wrapped in a single mrow). null → placeholder with a SLOT caret. */
  const slotChild = (path: Path, slot: SlotName, child: MathNode | null): Element =>
    child === null ? placeholder({ kind: 'slot', path, slot }) : wrapSlot(fragment(child, [...path, slot]));

  /** The op row tokens as loose elements: args joined by separator mo's.
   *  Mirrors OperatorNode.rowTokens (an empty args row shows one placeholder). */
  const rowTokens = (node: OperatorNode, path: Path): Element[] => {
    const display = OP_DISPLAY[node.op] ?? node.op;
    const args: (MathNode | null)[] = node.args.length === 0 ? [null] : node.args;
    const out: Element[] = [];
    args.forEach((arg, i) => {
      if (i > 0) {
        const sep = mo(display, false);
        separators.set(sep, { path, index: i });
        out.push(sep);
      }
      out.push(...rowChild(path, i, arg));
    });
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
      const frag = rowTokens(child, [...path, 'child']);
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
        mn.textContent = String((node as NumberNode).value);
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
          const mrow = el('mrow');
          const lead = mo(display, false);
          separators.set(lead, { path, index: 0 });
          mrow.appendChild(lead);
          if (op.args.length === 0) {
            mrow.appendChild(placeholder({ kind: 'row', path, index: 0 }));
          } else {
            op.args.forEach((arg, i) => {
              for (const f of rowChild(path, i, arg)) mrow.appendChild(f);
            });
          }
          return own(path, [mrow], mrow);
        }
        if (op.op === 'pow' && op.args.length <= 2) {
          // ≤2-arg pow op renders like PowerNode (msup); null args are row cells
          // (an op has no named slots), wrapped like slotMathml when multi-element.
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
        for (const f of rowTokens(op, path)) mrow.appendChild(f);
        return own(path, [mrow], mrow);
      }
      case 'fn': {
        const fn = node as FunctionNode;
        const mrow = el('mrow');
        const name = el('mi');
        name.textContent = fn.name;
        mrow.appendChild(name);
        mrow.appendChild(mo('(', true));
        fn.args.forEach((arg, i) => {
          if (i > 0) {
            const comma = mo(',', false);
            separators.set(comma, { path, index: i });
            mrow.appendChild(comma);
          }
          for (const f of rowChild(path, i, arg)) mrow.appendChild(f);
        });
        mrow.appendChild(mo(')', true));
        return own(path, [mrow], mrow);
      }
      case 'group': {
        const group = node as GroupNode;
        const mrow = el('mrow');
        const openFence = mo('(', true);
        mrow.appendChild(openFence);
        for (const f of hostedChild(path, group.child, openFence)) mrow.appendChild(f);
        mrow.appendChild(mo(')', true));
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
        if (root.index === null) {
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
        script.textContent = sub.sub;
        msub.appendChild(base);
        msub.appendChild(script);
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

  return { math, uidByPath, pathByUid, elementByPath, extents, placeholders, placeholderByCaret, separators };
}
