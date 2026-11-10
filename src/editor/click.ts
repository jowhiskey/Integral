// Click → structural caret placement — browser-only glue + a pure resolver.
//
// A click resolves in two stages:
//  1. hitFromMouseEvent maps the DOM event to a ClickHit using the UID maps of the
//     rendered tree: the raw target is checked against the element maps first
//     (□ placeholders, separator glyphs, a node's own uid element, container-
//     rendered fence glyphs, fn name heads, sub label elements), then the
//     closest uid-carrying ancestor (id-less wrappers: mspace, wrapSlot mrows);
//     geometric offset = fraction of the hit element's width.
//  2. caretFromHit (PURE — no DOM) maps the hit to the nearest legal structural
//     caret of the SAME state inventory arrows/typing address (OA-visual-trumps —
//     no separate clicked-station notion), per the ruled click rules:
//       - C2/S-057  placeholder (□)        → its recorded caret (the slot/row
//         caret before the □ — every □ producer)
//       - C1/S-053  separator glyph        → the ONE shared gap station it sits on
//         (row seam; the N2 corollary — operator glyphs have no own station)
//       - C1        num/sym token, unit    → the in-token character edge nearest
//         label                              the click x (character-wise, row
//                                             cells AND slot content alike —
//                                             supersedes the session-3
//                                             slot/root-num node-caret pins)
//       - C1        sub label elements     → character-wise within the label
//       - C1        fence token leaf       → the shared gaps flanking the glyph
//       - C3/S-056  fraction bar (mfrac)   → 50/50 across the bar's width: left
//         half → the gap before the whole fraction, right half → the gap after;
//         never enters num/den
//       - C4/S-054  fn name head           → right after the open paren (the
//         first argument start)
//       - C4        fence glyphs (parens)  → their nearest legal station: the
//         flank stations exist on both sides (OA-fence-flank) — open paren left
//         half → the left-of-`(` station, right half → the content start;
//         close paren mirrored
//       - C1        other containers/sub  → the outer-edge zones resolve to the
//         structure's OWN edge station (edgeStation: the mid-row flank, the
//         slot-boundary station, the lone-root border, the row-border seam),
//         falling back to the exit (exitStation); the middle dives into the
//         nearest flow end by click side
//       - C5/S-061  background (no hit)    → empty formula → the empty caret;
//         an op/row root's edge zones park at its border seams; otherwise
//         enter the root from the clicked side
// The result is validated with caretResolvesIn; placement is pure state and never
// enters the undo log, and never reads or writes the vertical-position memory
// (the controller sets the caret directly, not via moveCaret).

import type { Envelope } from '../ast/json.js';

import {
  NAV_PROFILES,
  caretResolvesIn,
  edgeStation,
  entryStation,
  exitStation,
  isRowNode,
  nodeAt,
  resolveMove,
  rowArgs,
  subLabelText,
  tokenText,
  type Caret,
  type NavRegistry,
  type Path,
  type SubLabel,
} from '../engine/index.js';

import { pathKey, type RenderedMath } from './mathml-dom.js';

/** What a click hit, after resolving the event against the element maps. */
export type ClickHit =
  | { readonly kind: 'none'; readonly fraction: number }
  | { readonly kind: 'placeholder'; readonly caret: Caret }
  | { readonly kind: 'separator'; readonly path: Path; readonly index: number }
  | { readonly kind: 'fence'; readonly path: Path; readonly side: 'open' | 'close'; readonly fraction: number }
  | { readonly kind: 'fnHead'; readonly path: Path }
  | { readonly kind: 'subLabel'; readonly path: Path; readonly label: SubLabel; readonly fraction: number }
  | { readonly kind: 'node'; readonly path: Path; readonly fraction: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Nearest in-token character boundary for a click at `fraction` of a token of
 *  length `len` (C1 nearest-edge). */
const tokenIndex = (fraction: number, len: number): number =>
  Math.max(0, Math.min(len, Math.round(fraction * len)));

/** The outer-edge zone of a container's extent (fraction from each side) where
 *  a click resolves to the structure's own edge station instead of diving in. */
const EDGE_ZONE = 0.25;

const fractionOf = (clientX: number, el: Element): number => {
  const r = el.getBoundingClientRect();
  return r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0.5;
};

/**
 * Map a mouse event on the editor container to a ClickHit. `event.target` is the
 * deepest DOM node under the pointer; text-node targets don't occur for mouse
 * events, so the target is an element. Element maps are checked on the raw
 * target first (placeholders, separators, own-uid elements, fence glyphs, fn
 * heads, sub labels), then the closest uid-carrying ancestor.
 */
export function hitFromMouseEvent(event: MouseEvent, rendered: RenderedMath): ClickHit {
  const target = event.target;
  if (!(target instanceof Element)) {
    return { kind: 'none', fraction: fractionOf(event.clientX, rendered.math) };
  }
  const ph = rendered.placeholders.get(target);
  if (ph) return { kind: 'placeholder', caret: ph };
  const sep = rendered.separators.get(target);
  if (sep) return { kind: 'separator', path: sep.path, index: sep.index };
  // Fence glyphs of containers (group/fn parens) are recognized as fence hits
  // even when the mo carries a uid — a group with an inlined flat row child
  // stamps the OPEN paren with the child row's uid, but the element is still
  // the fence glyph for click purposes (C4). A dangling fence TOKEN's own mo
  // carries its OWN uid (same path) — that one stays a node hit (the movable
  // glyph token leaf → the flanking shared gaps).
  const fence = rendered.fenceGlyphs.get(target);
  const ownPath = target.id !== '' ? rendered.pathByUid.get(target.id) : undefined;
  if (fence !== undefined && (ownPath === undefined || pathKey(ownPath) !== pathKey(fence.path))) {
    return { kind: 'fence', path: fence.path, side: fence.side, fraction: fractionOf(event.clientX, target) };
  }
  // a node's own uid element hit directly (leaves, containers, the unit's label
  // mi, a dangling fence token's mo): the fraction is within that element
  if (ownPath !== undefined) {
    return { kind: 'node', path: ownPath, fraction: fractionOf(event.clientX, target) };
  }
  const head = rendered.fnHeads.get(target);
  if (head !== undefined) return { kind: 'fnHead', path: head };
  for (const [key, labels] of rendered.subLabels) {
    if (labels.base === target) {
      return { kind: 'subLabel', path: JSON.parse(key) as Path, label: 'base', fraction: fractionOf(event.clientX, target) };
    }
    if (labels.script === target) {
      return { kind: 'subLabel', path: JSON.parse(key) as Path, label: 'sub', fraction: fractionOf(event.clientX, target) };
    }
  }
  const idEl = target.closest('[id]');
  if (idEl !== null) {
    const path = rendered.pathByUid.get(idEl.getAttribute('id') ?? '');
    if (path !== undefined) {
      return { kind: 'node', path, fraction: fractionOf(event.clientX, idEl) };
    }
  }
  return { kind: 'none', fraction: fractionOf(event.clientX, rendered.math) };
}

/** Entering a container from `side` = its flow-end station on that side. Reuses the
 *  engine's own movement: a node caret on the container + move toward the opposite
 *  side dives to the entry station (resolveMove's self-on-container rule). */
const enterSide = (env: Envelope, path: Path, side: 'left' | 'right', registry: NavRegistry): Caret | null =>
  resolveMove(env, { kind: 'node', path }, side === 'left' ? 'right' : 'left', registry);

/** The first candidate that resolves in the tree, else null. */
const firstResolving = (env: Envelope, candidates: readonly (Caret | null)[]): Caret | null => {
  for (const c of candidates) {
    if (c !== null && caretResolvesIn(env, c)) return c;
  }
  return null;
};

/**
 * The pure click→caret resolver: nearest legal structural caret for a hit, per the
 * ruled click rules C1–C5 against the final position inventory. Always returns a
 * resolvable caret (falls back to the empty-formula caret / the root's end station).
 */
export function caretFromHit(env: Envelope, hit: ClickHit, registry: NavRegistry = NAV_PROFILES): Caret {
  const fallback: Caret =
    env.root === null ? { kind: 'empty' } : (entryStation(env, [], 'right', registry) ?? { kind: 'node', path: [] });
  let caret: Caret;
  switch (hit.kind) {
    case 'placeholder':
      // C2/S-057: the □ is the empty slot's click target — the recorded caret
      // sits before the □
      caret = hit.caret;
      break;
    case 'separator':
      // C1/S-053 (the N2 corollary): an operator glyph/comma element maps to
      // the ONE shared gap station it sits on
      caret = { kind: 'row', path: hit.path, index: hit.index };
      break;
    case 'fnHead':
      // C4/S-054: the head's name area → right after the open paren (the first
      // argument's start — the □ row caret when the first argument is empty)
      caret = entryStation(env, hit.path, 'left', registry) ?? { kind: 'node', path: hit.path };
      break;
    case 'subLabel': {
      // C1 (T9 sub labels): character-wise within the clicked label
      const node = nodeAt(env, hit.path);
      const len = node !== null && node.type === 'sub' ? subLabelText(node, hit.label).length : 0;
      caret = { kind: 'token', path: hit.path, index: tokenIndex(hit.fraction, len), label: hit.label };
      break;
    }
    case 'fence': {
      // C4: a fence glyph resolves to its nearest legal station — open paren:
      // left half → the left-of-`(` station, right half → the content start
      // (after the paren); close paren mirrored (before `)` vs after `)`)
      const open = hit.side === 'open';
      const outside = edgeStation(env, hit.path, open ? 'left' : 'right');
      const inside = entryStation(env, hit.path, open ? 'left' : 'right', registry);
      const near = open ? (hit.fraction < 0.5 ? outside : inside) : (hit.fraction < 0.5 ? inside : outside);
      const far = open ? (hit.fraction < 0.5 ? inside : outside) : (hit.fraction < 0.5 ? outside : inside);
      caret = firstResolving(env, [near, far, { kind: 'node', path: hit.path }]) ?? fallback;
      break;
    }
    case 'none': {
      // C5/S-061: background snap. In the outer edge zones around an op/fn
      // root row the caret parks at the row's border seam — the visible
      // start/end of the formula — instead of diving into the far flow
      // end; the middle zones keep the enter-from-side dive. Non-row roots
      // have no border seam to express: they keep the dive unchanged.
      const root = env.root;
      if (root !== null && isRowNode(root) && (hit.fraction <= EDGE_ZONE || hit.fraction >= 1 - EDGE_ZONE)) {
        caret = { kind: 'row', path: [], index: hit.fraction >= 1 - EDGE_ZONE ? rowArgs(root).length : 0 };
        break;
      }
      caret =
        env.root === null
          ? { kind: 'empty' }
          : (enterSide(env, [], hit.fraction < 0.5 ? 'left' : 'right', registry) ?? { kind: 'node', path: [] });
      break;
    }
    case 'node': {
      const node = nodeAt(env, hit.path);
      if (node === null) {
        caret = fallback;
        break;
      }
      if (node.type === 'num' || node.type === 'sym' || node.type === 'unit') {
        // C1 nearest-edge: text-like tokens resolve character-wise wherever
        // they stand — row cells and slot content alike (the unit's own
        // element IS its upright label). Supersedes the session-3
        // slot/root-num node-caret pins.
        caret = { kind: 'token', path: hit.path, index: tokenIndex(hit.fraction, tokenText(node).length) };
        break;
      }
      if (node.type === 'fence') {
        // a movable close-glyph token leaf: the shared gaps flanking the glyph
        const last = hit.path.length > 0 ? hit.path[hit.path.length - 1] : null;
        caret =
          typeof last === 'number'
            ? { kind: 'row', path: hit.path.slice(0, -1), index: last + (hit.fraction < 0.5 ? 0 : 1) }
            : { kind: 'node', path: hit.path };
        break;
      }
      const profile = registry[node.type] ?? { children: 'leaf' as const };
      if (profile.children === 'leaf' && node.type !== 'sub') {
        caret = { kind: 'node', path: hit.path };
        break;
      }
      if (node.type === 'frac') {
        // C3/S-056: the bar maps to the flanking gaps of the WHOLE fraction,
        // 50/50 across the bar's own width — never inside num/den
        const side = hit.fraction < 0.5 ? 'left' : 'right';
        caret =
          firstResolving(env, [
            edgeStation(env, hit.path, side),
            enterSide(env, hit.path, side, registry),
            { kind: 'node', path: hit.path },
          ]) ?? fallback;
        break;
      }
      // containers (args rows, group, pow, root) and the subscript: the
      // outer-edge zones resolve to the structure's OWN edge station (the
      // mid-row flank / slot-boundary station / lone-root border / row-border
      // seam — OA-flank-stations, OA-fence-flank), then the outside exit; the
      // middle dives into the nearest flow end by click side
      if (hit.fraction >= 1 - EDGE_ZONE || hit.fraction <= EDGE_ZONE) {
        const side = hit.fraction >= 1 - EDGE_ZONE ? ('right' as const) : ('left' as const);
        caret =
          firstResolving(env, [
            edgeStation(env, hit.path, side),
            exitStation(env, hit.path, side, registry),
            enterSide(env, hit.path, hit.fraction < 0.5 ? 'left' : 'right', registry),
            { kind: 'node', path: hit.path },
          ]) ?? fallback;
      } else {
        caret =
          firstResolving(env, [
            enterSide(env, hit.path, hit.fraction < 0.5 ? 'left' : 'right', registry),
            { kind: 'node', path: hit.path },
          ]) ?? fallback;
      }
      break;
    }
  }
  return caretResolvesIn(env, caret) ? caret : fallback;
}
