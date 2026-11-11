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
  rowEndStation,
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
  | { readonly kind: 'separator'; readonly path: Path; readonly index: number; readonly fraction: number }
  | { readonly kind: 'fence'; readonly path: Path; readonly side: 'open' | 'close'; readonly fraction: number }
  | { readonly kind: 'fnHead'; readonly path: Path; readonly fraction: number }
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
    return nearestBackgroundHit(event.clientX, rendered) ?? { kind: 'none', fraction: fractionOf(event.clientX, rendered.math) };
  }
  const ph = rendered.placeholders.get(target);
  if (ph) return { kind: 'placeholder', caret: ph };
  const sep = rendered.separators.get(target);
  if (sep) return { kind: 'separator', path: sep.path, index: sep.index, fraction: fractionOf(event.clientX, target) };
  // Fence glyphs of containers (group/fn parens) are recognized as fence hits
  // even when the mo carries a uid — a group with an inlined flat row child
  // stamps the OPEN paren with the child row's uid, but the element is still
  // the fence glyph for click purposes (C4). A dangling fence TOKEN's own mo
  // carries its OWN uid (same path) — that one stays a node hit (the movable
  // glyph token leaf → the flanking shared gaps).
  const fence = rendered.fenceGlyphs.get(target);
  const ownPath = target.id !== '' ? rendered.pathByUid.get(target.id) : undefined;
  if (fence !== undefined && (ownPath === undefined || pathKey(ownPath) !== pathKey(fence.path))) {
    // K-19: an fn's open paren is the right part of the `name(` block — its
    // click fraction is measured within the whole block, not the glyph
    const blockFraction = fence.side === 'open' ? fnHeadBlockFraction(event.clientX, fence.path, rendered) : null;
    return { kind: 'fence', path: fence.path, side: fence.side, fraction: blockFraction ?? fractionOf(event.clientX, target) };
  }
  // a node's own uid element hit directly (leaves, containers, the unit's label
  // mi, a dangling fence token's mo): the fraction is within that element
  if (ownPath !== undefined) {
    return { kind: 'node', path: ownPath, fraction: fractionOf(event.clientX, target) };
  }
  const head = rendered.fnHeads.get(target);
  if (head !== undefined) {
    return { kind: 'fnHead', path: head, fraction: fnHeadBlockFraction(event.clientX, head, rendered) ?? fractionOf(event.clientX, target) };
  }
  const sub = subLabelHit(rendered, target, event.clientX);
  if (sub !== null) return sub;
  const idEl = target.closest('[id]');
  if (idEl !== null) {
    const path = rendered.pathByUid.get(idEl.getAttribute('id') ?? '');
    if (path !== undefined) {
      return { kind: 'node', path, fraction: fractionOf(event.clientX, idEl) };
    }
  }
  // background (the <math> element, id-less wrappers): snap to the nearest
  // rendered element (K-08 fix) — the pure none-hit stays as the fallback when
  // nothing is rendered (the empty formula).
  return nearestBackgroundHit(event.clientX, rendered) ?? { kind: 'none', fraction: fractionOf(event.clientX, rendered.math) };
}

/** A click's two candidate stations in near/far order (left half → [a, b]). */
const clickHalves = (fraction: number, a: Caret | null, b: Caret | null): [Caret | null, Caret | null] =>
  fraction < 0.5 ? [a, b] : [b, a];

/** The subLabel hit when `target` is one of a sub's two label elements (T9). */
function subLabelHit(rendered: RenderedMath, target: Element, clientX: number): ClickHit | null {
  for (const [key, labels] of rendered.subLabels) {
    const path = JSON.parse(key) as Path;
    if (labels.base === target) {
      return { kind: 'subLabel', path, label: 'base', fraction: fractionOf(clientX, target) };
    }
    if (labels.script === target) {
      return { kind: 'subLabel', path, label: 'sub', fraction: fractionOf(clientX, target) };
    }
  }
  return null;
}

/** The click fraction within a function's whole `name(` head block (the name
 *  <mi> ∪ the open-paren <mo>): K-19's overwrite (owner, fix round
 *  2026-11-10) — `sin(` is ONE block split in the MIDDLE for click handling:
 *  left half → `|sin(` (before the head), right half → `sin(|` (right after
 *  the open paren). Null when `path` is not an fn (groups keep per-glyph
 *  halves). */
function fnHeadBlockFraction(clientX: number, path: Path, rendered: RenderedMath): number | null {
  let name: Element | undefined;
  let open: Element | undefined;
  for (const [el, p] of rendered.fnHeads) if (pathKey(p) === pathKey(path)) name = el;
  for (const [el, f] of rendered.fenceGlyphs) if (f.side === 'open' && pathKey(f.path) === pathKey(path)) open = el;
  if (name === undefined || open === undefined) return null;
  const a = name.getBoundingClientRect();
  const b = open.getBoundingClientRect();
  const left = Math.min(a.left, b.left);
  const right = Math.max(a.right, b.right);
  return right > left ? clamp01((clientX - left) / (right - left)) : 0.5;
}

/** The nearest rendered element to a background click's x — deepest containing
 *  element wins (smallest width at distance 0), otherwise the nearest edge.
 *  A background click snaps to it (C5/S-061's nearest legal position) instead
 *  of the coarse whole-math 50/50 split — the 4b-2 K-08 live finding: clicking
 *  "in front of sin" in `x + sin(a) + y` resolved to the formula start and
 *  typing there landed at the start; the head's left-edge zone already maps
 *  to the flank correctly, and the background now feeds the same per-element
 *  rules. Zero-width (unstubbed/invisible) elements never win. */
function nearestBackgroundHit(clientX: number, rendered: RenderedMath): ClickHit | null {
  interface Candidate {
    readonly fractionEl: Element;
    readonly d: number;
    readonly width: number;
    readonly make: (fraction: number) => ClickHit;
  }
  const candidates: Candidate[] = [];
  const consider = (left: number, right: number, fractionEl: Element, make: (fraction: number) => ClickHit): void => {
    const width = right - left;
    if (width <= 0) return;
    const d = clientX < left ? left - clientX : clientX > right ? clientX - right : 0;
    candidates.push({ fractionEl, d, width, make });
  };
  for (const [el, caret] of rendered.placeholders) {
    const r = el.getBoundingClientRect();
    consider(r.left, r.right, el, () => ({ kind: 'placeholder', caret }));
  }
  for (const [el, sep] of rendered.separators) {
    const r = el.getBoundingClientRect();
    consider(r.left, r.right, el, (f) => ({ kind: 'separator', path: sep.path, index: sep.index, fraction: f }));
  }
  for (const [el, f] of rendered.fenceGlyphs) {
    const r = el.getBoundingClientRect();
    consider(r.left, r.right, el, (fr) => ({ kind: 'fence', path: f.path, side: f.side, fraction: fr }));
  }
  for (const [el, path] of rendered.fnHeads) {
    const r = el.getBoundingClientRect();
    consider(r.left, r.right, el, (f) => ({ kind: 'fnHead', path, fraction: fnHeadBlockFraction(clientX, path, rendered) ?? f }));
  }
  for (const [key, labels] of rendered.subLabels) {
    const path = JSON.parse(key) as Path;
    for (const [label, el] of [['base', labels.base], ['sub', labels.script]] as const) {
      const r = el.getBoundingClientRect();
      consider(r.left, r.right, el, (f) => ({ kind: 'subLabel', path, label, fraction: f }));
    }
  }
  for (const [key, ext] of rendered.extents) {
    const own = rendered.elementByPath.get(key);
    if (own === undefined) continue;
    const path = JSON.parse(key) as Path;
    const a = ext.first.getBoundingClientRect();
    const b = ext.last.getBoundingClientRect();
    consider(Math.min(a.left, b.left), Math.max(a.right, b.right), own, (f) => ({ kind: 'node', path, fraction: f }));
  }
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (best === null || c.d < best.d || (c.d === best.d && c.width < best.width)) best = c;
  }
  if (best === null) return null;
  return best.make(fractionOf(clientX, best.fractionEl));
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
    case 'separator': {
      // C1/S-053 (the N2 corollary): an operator glyph/comma element maps to
      // the ONE shared gap station it sits on. OA-glyph-click-halves (ruled
      // 2026-11-10): the glyph's LEFT half resolves to the position BEFORE
      // the glyph — the left-adjacent cell's own right-edge station (the
      // in-token end for tokens, the right flank for mid-row structures —
      // all existing restable/insertable states, no new caret kind); the
      // right half keeps today's behind-the-glyph shared gap.
      if (hit.index > 0 && hit.fraction < 0.5) {
        const leftPath = [...hit.path, hit.index - 1] as Path;
        const before = edgeStation(env, leftPath, 'right') ?? entryStation(env, leftPath, 'right', registry);
        caret = firstResolving(env, [before, { kind: 'row', path: hit.path, index: hit.index }]) ?? fallback;
      } else {
        caret = { kind: 'row', path: hit.path, index: hit.index };
      }
      break;
    }
    case 'fnHead': {
      // K-19 overwrite (owner, fix round 2026-11-10; supersedes C4's flat
      // "name → arg start"): `sin(` is ONE block split in the middle — the
      // block's LEFT half → `|sin(` (before the head, the left flank), the
      // RIGHT half → `sin(|` (right after the open paren = the first
      // argument's start). The fraction is measured within the whole block.
      const before = edgeStation(env, hit.path, 'left');
      const after = entryStation(env, hit.path, 'left', registry) ?? { kind: 'node', path: hit.path };
      caret = firstResolving(env, clickHalves(hit.fraction, before, after)) ?? fallback;
      break;
    }
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
      const [near, far] = clickHalves(hit.fraction, open ? outside : inside, open ? inside : outside);
      caret = firstResolving(env, [near, far, { kind: 'node', path: hit.path }]) ?? fallback;
      break;
    }
    case 'none': {
      // C5/S-061: background snap. In the outer edge zones around a root row
      // the caret parks at the row's CANONICAL border station (rowEndStation —
      // the OA-visual-trumps collapse: a text/pair border cell's in-token
      // edge, a structure cell's seam — the raw `row [] #0` twin producer is
      // gone; an fn root parks at its fence-past border station) instead of
      // diving into the far flow end; the middle zones keep the
      // enter-from-side dive. Non-row roots keep the dive unchanged.
      const root = env.root;
      if (root !== null && (hit.fraction <= EDGE_ZONE || hit.fraction >= 1 - EDGE_ZONE)) {
        const side: 'left' | 'right' = hit.fraction >= 1 - EDGE_ZONE ? 'right' : 'left';
        if (root.type === 'fn') {
          caret = { kind: 'node', path: [], side };
          break;
        }
        if (isRowNode(root)) {
          caret =
            rowEndStation(env, [], side, registry) ??
            { kind: 'row', path: [], index: side === 'right' ? rowArgs(root).length : 0 };
          break;
        }
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
            // a row's own edge zone parks at its canonical border seam
            // (rowEndStation — the OA-visual-trumps border collapse) before
            // the exit/dive fallbacks
            ...(isRowNode(node) && node.type === 'op' && hit.path.length === 0 ? [rowEndStation(env, hit.path, side, registry)] : []),
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
