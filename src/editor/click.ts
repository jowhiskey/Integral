// Click → structural caret placement — browser-only glue + a pure resolver.
//
// A click resolves in two stages:
//  1. hitFromMouseEvent maps the DOM event to a ClickHit using the UID maps of the
//     rendered tree: the deepest element carrying a uid wins (closest('[id]')),
//     with geometric offset = fraction of the element's width; <mi>□</mi>
//     placeholders and row separator mo's are recognized via their maps first.
//  2. caretFromHit (PURE — no DOM) maps the hit to the nearest legal structural
//     caret per the nav-profile geography:
//       - placeholder        → its recorded caret (slot caret / empty row cell)
//       - separator glyph    → the row seam it sits on
//       - number leaf in a row → the in-token caret at the nearest character
//         boundary of the token's extent (offset from the click x)
//       - leaf node, row parent, left/right half → the seam directly before/after
//         the cell (row caret index i / i+1)
//       - leaf node otherwise (slot content, root) → the node caret on the leaf
//       - container, outer-edge zone → the nearest legal station OUTSIDE the
//         parent (exitStation), else left/right half → the leftmost/rightmost
//         station inside (enter-from-side = resolveMove from a node caret on
//         the container)
//       - no uid hit (math/container background) → empty caret for the empty
//         formula; an op/row root parked at its start/end seam in the outer
//         edge zones; otherwise enter the root from the clicked side
// The result is validated with caretResolvesIn; placement is pure state and never
// enters the undo log (the controller sets the caret directly, not via moveCaret).

import type { Envelope } from '../ast/json.js';

import {
  NAV_PROFILES,
  caretResolvesIn,
  exitStation,
  isRowNode,
  nodeAt,
  resolveMove,
  rowArgs,
  tokenText,
  type Caret,
  type NavRegistry,
  type Path,
} from '../engine/index.js';

import type { RenderedMath } from './mathml-dom.js';

/** What a click hit, after resolving the event against the UID maps. */
export type ClickHit =
  | { readonly kind: 'none'; readonly fraction: number }
  | { readonly kind: 'placeholder'; readonly caret: Caret }
  | { readonly kind: 'separator'; readonly path: Path; readonly index: number }
  | { readonly kind: 'node'; readonly path: Path; readonly fraction: number };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The outer-edge zone of a container's extent (fraction from each side) where
 *  a click exits the parent instead of diving into it. */
const EDGE_ZONE = 0.25;

const fractionOf = (clientX: number, el: Element): number => {
  const r = el.getBoundingClientRect();
  return r.width > 0 ? clamp01((clientX - r.left) / r.width) : 0.5;
};

/**
 * Map a mouse event on the editor container to a ClickHit. `event.target` is the
 * deepest DOM node under the pointer; text-node targets don't occur for mouse
 * events, so the target is an element — placeholder/separator maps are checked on
 * the raw target first, then the closest uid-carrying ancestor.
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

/**
 * The pure click→caret resolver: nearest legal structural caret for a hit, per the
 * nav-profile geography. Always returns a resolvable caret (falls back to the
 * empty-formula caret / root node caret).
 */
export function caretFromHit(env: Envelope, hit: ClickHit, registry: NavRegistry = NAV_PROFILES): Caret {
  const fallback: Caret = env.root === null ? { kind: 'empty' } : { kind: 'node', path: [] };
  let caret: Caret;
  switch (hit.kind) {
    case 'placeholder':
      caret = hit.caret;
      break;
    case 'separator':
      caret = { kind: 'row', path: hit.path, index: hit.index };
      break;
    case 'none': {
      // Background (no uid hit): in the outer edge zones around an op/fn
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
      const profile = registry[node.type] ?? { children: 'leaf' as const };
      if (profile.children === 'leaf') {
        const last = hit.path.length > 0 ? hit.path[hit.path.length - 1] : null;
        if (node.type === 'num' && typeof last === 'number') {
          // a number in an args row: the nearest in-token boundary (character
          // offset from the click x within the token's extent)
          const len = tokenText(node).length;
          const index = Math.max(0, Math.min(len, Math.round(hit.fraction * len)));
          caret = { kind: 'token', path: hit.path, index };
        } else {
          caret =
            typeof last === 'number'
              ? // leaf in an args row: the seam directly before/after its cell
                { kind: 'row', path: hit.path.slice(0, -1), index: last + (hit.fraction < 0.5 ? 0 : 1) }
              : { kind: 'node', path: hit.path };
        }
      } else {
        // container: a click in the outer-edge zone exits the parent to the
        // nearest legal station OUTSIDE it (click-to-exit, e.g. just right of
        // a group's closing paren → the station after the group); the rest
        // dives into the nearest flow end by click side.
        const exit =
          hit.fraction >= 1 - EDGE_ZONE
            ? exitStation(env, hit.path, 'right', registry)
            : hit.fraction <= EDGE_ZONE
              ? exitStation(env, hit.path, 'left', registry)
              : null;
        caret =
          (exit !== null && caretResolvesIn(env, exit) ? exit : null) ??
          enterSide(env, hit.path, hit.fraction < 0.5 ? 'left' : 'right', registry) ??
          { kind: 'node', path: hit.path };
      }
      break;
    }
  }
  return caretResolvesIn(env, caret) ? caret : fallback;
}
