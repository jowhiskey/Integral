// Navigation profiles as data + type-blind relative movement (arc session 2).
//
// Each node type declares its caret geography in a NavProfile: how children
// are addressed, the traversal flow of named slots, and the left/right and
// up/down adjacency edges between them. Movement resolution reads only that
// data (plus structural facts of the tree: filled/empty slots, args indices)
// — it never branches on a node type, so replacing one type's profile data
// changes that type's movement behavior with zero engine changes. A missing
// profile degrades to leaf behavior (exit-only), never a crash.
//
// Movement semantics (pinned by the editing-layer principles):
// - traversal through a layout follows its flow: a fraction is entered at
//   the numerator, and the numerator flows DOWN into the denominator, never
//   sideways — horizontal overflow from a stacked slot exits the node.
// - up/down edges are jumps: the caret lands ON the target slot's content
//   (or its empty-slot caret when the slot is empty). Horizontal flow is
//   continuous: crossing into a slot dives to the leftmost/rightmost
//   station inside it.
// - movement with no target (empty formula, direction into nothing) is a
//   defined no-op: the resolver returns null. Exception: a horizontal
//   overflow that runs off an args row's border with no station up the
//   climb rests at that row's border seam — the caret parks at the
//   start/end of the region it flowed out of instead of the move dying.

import type { Envelope, NodeJson } from '../ast/json.js';
import {
  caretResolvesIn,
  hasSlot,
  isRowNode,
  isTokenNode,
  nodeAt,
  rowArgs,
  slotValue,
  subLabelText,
  tokenText,
  type Caret,
  type Path,
  type SlotName,
} from './caret.js';

/** Arrow directions the move op understands. */
export type NavDir = 'left' | 'right' | 'up' | 'down';

/** An adjacency between two slots of one node type: moving `dir` from
 *  position `from` targets slot `to` (an empty `to` rests in its slot
 *  caret). Edges reference slots their type actually owns; unowned or
 *  inactive targets degrade the edge to absent (movement stays defined). */
export interface NavEdge {
  readonly from: SlotName;
  readonly dir: NavDir;
  readonly to: SlotName;
}

/** The caret geography of one node type — pure data. */
export interface NavProfile {
  /** How children are addressed and traversed:
   *  - 'leaf'  : no addressable internals; the node is one exit-only
   *              station (num, sym, sub — script strings are name channels,
   *              not slots).
   *  - 'args'  : dynamic args row (op, fn); positions are indices.
   *  - 'slots' : fixed named slots, traversed in `flow` order. */
  readonly children: 'leaf' | 'args' | 'slots';
  /** ('slots') Named slots in traversal order: entering from the left
   *  enters flow[0], from the right the last active flow slot. For stacked
   *  layouts this is the vertical/reading layout order. */
  readonly flow?: readonly SlotName[];
  /** Flow slots that are part of the geography only when filled — a square
   *  root's omitted index is a complete tree with no index geography (an
   *  unfilled slot here is skipped everywhere: entry, edges). */
  readonly filledOnly?: readonly SlotName[];
  /** Left/right adjacency between slots. No edge for a slot: horizontal
   *  flow out of that slot exits the whole node into the parent's flow. */
  readonly horizontal?: readonly NavEdge[];
  /** Up/down adjacency between slots. No edge (or a row/leaf owner):
   *  vertical movement climbs to the parent's geography. */
  readonly vertical?: readonly NavEdge[];
  /** The slot crossed INTO from the node's right boundary (horizontal
   *  entry from an adjacent row position; rework 4a, N5/S-094): the
   *  fraction's horizontal interface is the NUMERATOR on both edges, and a
   *  root's right boundary rides its RADICAND (the index is a front-top
   *  script, never the right end). Absent = the last active flow slot
   *  (pow's exponent — S-094's power reading). */
  readonly enterRight?: SlotName;
}

/** A nav-profile registry: one profile per node type. */
export type NavRegistry = Readonly<Record<NodeJson['type'], NavProfile>>;

const LEAF_PROFILE: NavProfile = { children: 'leaf' };
const ROW_PROFILE: NavProfile = { children: 'args' };

/** The default registry: all node types (incl. the additive fence token). */
export const NAV_PROFILES: NavRegistry = {
  num: LEAF_PROFILE,
  sym: LEAF_PROFILE,
  sub: LEAF_PROFILE,
  op: ROW_PROFILE,
  fn: ROW_PROFILE,
  group: { children: 'slots', flow: ['child'] },
  // Stacked layout: entered at the numerator, which flows DOWN into the
  // denominator — never sideways. Horizontal overflow from either slot
  // exits the fraction into the parent's flow. The HORIZONTAL interface is
  // the numerator on BOTH edges: → from the left enters the num (S-042),
  // ← from the right enters the num's END, never the geometrically
  // adjacent denominator (S-094, N5).
  frac: {
    children: 'slots',
    flow: ['num', 'den'],
    enterRight: 'num',
    vertical: [
      { from: 'num', dir: 'down', to: 'den' },
      { from: 'den', dir: 'up', to: 'num' },
    ],
  },
  // Chained layout: the exponent script is glued to the base — base flows
  // right into it and back — and is also its vertical (raised-script) edge.
  pow: {
    children: 'slots',
    flow: ['base', 'exp'],
    horizontal: [
      { from: 'base', dir: 'right', to: 'exp' },
      { from: 'exp', dir: 'left', to: 'base' },
    ],
    vertical: [
      { from: 'base', dir: 'up', to: 'exp' },
      { from: 'exp', dir: 'down', to: 'base' },
    ],
  },
  // Stacked layout: the radicand is the main content; the (raised, front)
  // index participates only when the tree actually carries one. The RIGHT
  // boundary rides the radicand — the index is a front-top script, so ←
  // into a root lands at the radicand's end (S-094's right-entry pin).
  root: {
    children: 'slots',
    flow: ['radicand', 'index'],
    filledOnly: ['index'],
    enterRight: 'radicand',
    vertical: [
      { from: 'radicand', dir: 'up', to: 'index' },
      { from: 'index', dir: 'down', to: 'radicand' },
    ],
  },
  // The unit symbol is a string channel, not a slot: only the value is
  // traversable; the unit block as a whole is exit-only.
  unit: { children: 'slots', flow: ['value'] },
  // A close-fence glyph token (movable-paren model) is a plain leaf in the
  // row geography — full caret/nav treatment arrives with session 3's fence map.
  fence: LEAF_PROFILE,
};

const profileFor = (registry: NavRegistry, node: NodeJson): NavProfile =>
  registry[node.type] ?? LEAF_PROFILE;

/** The traversal-flow slots of `node` that are active: owned by the type and
 *  filled when required (`filledOnly`). */
function activeFlow(profile: NavProfile, node: NodeJson): SlotName[] {
  const filledOnly = profile.filledOnly ?? [];
  return (profile.flow ?? []).filter(
    (slot) => hasSlot(node, slot) && (!filledOnly.includes(slot) || slotValue(node, slot) !== null),
  );
}

/** Arrival at a slot target of the owner at `ownerPath`:
 *  - empty slot → the slot caret (an empty slot is a movement target)
 *  - horizontal arrival dives into the slot's content (continuous flow);
 *  - vertical arrival lands at the END of the target region's content,
 *    diving through wrappers (OA-vertical-default, N6) via `contentEnd` —
 *    the rest state the owner ratified 2026-11-09: the first possible
 *    resting position, never ON a structure.
 */
function arriveAtSlot(
  env: Envelope,
  owner: NodeJson,
  ownerPath: Path,
  slot: SlotName,
  dir: NavDir,
  registry: NavRegistry,
): Caret | null {
  const content = slotValue(owner, slot);
  if (content === null) return { kind: 'slot', path: ownerPath, slot };
  if (dir === 'up' || dir === 'down') return contentEnd(env, [...ownerPath, slot], registry);
  return dir === 'right'
    ? bench(env, [...ownerPath, slot], 'left', registry)
    : enterFromSide(env, [...ownerPath, slot], 'right', registry);
}

/** Edge lookup inside one owner: the slot `dir` from position `from` targets,
 *  or null when no such edge exists, its target slot is unowned, or it is
 *  inactive (filledOnly and empty). Returns only the target slot name. */
function edgeTo(profile: NavProfile, owner: NodeJson, from: SlotName, dir: NavDir): SlotName | null {
  for (const edge of (dir === 'up' || dir === 'down' ? profile.vertical : profile.horizontal) ?? []) {
    if (edge.from !== from || edge.dir !== dir) continue;
    if (!hasSlot(owner, edge.to)) continue;
    if ((profile.filledOnly ?? []).includes(edge.to) && slotValue(owner, edge.to) === null) continue;
    return edge.to;
  }
  return null;
}

// ——— Visual-geometry stations (rework 4a — OA-visual-trumps) ———
//
// The rendered structure, not the AST shape, decides the geography: entries
// land at token interiors (in-token carets), the first/last cell of a row,
// or a slot — never ON a node whose spot another state already paints
// (node carets on tokens duplicate the gap to their left; the vertical
// "onto the content node" arrival duplicated the content's own end).

type Side = 'left' | 'right';

/** True iff the node's TEXT-addressed channel ends at its visual right
 *  edge (num/sym tokens, sub label runs, unit labels): its in-token end
 *  IS its whole end (OA-visual-trumps — no seam/station beyond it). */
function textLikeEnd(node: NodeJson): boolean {
  return node.type === 'num' || node.type === 'sym' || node.type === 'sub';
}

/**
 * The station reached entering the node at `path` from the given side: the
 * leftmost/rightmost rest position of its content.
 * - text tokens: the in-token offset at the entering edge (num/sym; a sub
 *   enters at its base label from the left, its script label from the
 *   right; a unit's label IS its right end, while the value is its left
 *   entry)
 * - the fence close token: the station on the glyph itself (the pre-fence
 *   position — D8's char-wise chain addresses it; no other state paints
 *   there)
 * - args row: the first/last cell: filled → dived, a gap (null cell) → the
 *   row caret at its index, an empty row → the insertion point at index 0
 * - slots: the first/last active flow slot: empty → slot caret, filled →
 *   dive (entry on the entering side).
 */
function bench(env: Envelope, path: Path, side: Side, registry: NavRegistry): Caret | null {
  const node = nodeAt(env, path);
  if (node === null) return null;
  const profile = profileFor(registry, node);
  switch (node.type) {
    case 'num':
    case 'sym':
      return { kind: 'token', path, index: side === 'left' ? 0 : tokenText(node).length };
    case 'sub':
      return side === 'left'
        ? { kind: 'token', path, index: 0, label: 'base' }
        : { kind: 'token', path, index: subLabelText(node, 'sub').length, label: 'sub' };
    case 'unit': {
      const label = tokenText(node);
      if (side === 'right' && label.length > 0) return { kind: 'token', path, index: label.length };
      break; // left entry (or an empty label): the value slot flow below
    }
    case 'fence':
      return { kind: 'node', path };
    default:
      break;
  }
  switch (profile.children) {
    case 'leaf':
      return { kind: 'node', path };
    case 'slots': {
      const flow = side === 'left' ? activeFlow(profile, node) : [...activeFlow(profile, node)].reverse();
      const slot = flow[0];
      if (slot === undefined) return null;
      return slotValue(node, slot) === null
        ? { kind: 'slot', path, slot }
        : bench(env, [...path, slot], side, registry);
    }
    case 'args': {
      if (!isRowNode(node)) return null;
      const args = rowArgs(node);
      if (args.length === 0) return { kind: 'row', path, index: 0 };
      const i = side === 'left' ? 0 : args.length - 1;
      // the crossing into a structure cell honors its enterRight interface
      // (S-094 — a fraction's horizontal right boundary is its numerator)
      return args[i] === null ? { kind: 'row', path, index: i } : enterFromSide(env, [...path, i], side, registry);
    }
  }
}

/** Entering the node at `path` across its right boundary, from an adjacent
 *  row position: consults the profile's `enterRight` override (N5/S-094 —
 *  a fraction's horizontal interface is the numerator on BOTH edges, a
 *  root's right boundary its radicand); everything else benches right. */
function enterFromSide(env: Envelope, path: Path, side: Side, registry: NavRegistry): Caret | null {
  const node = nodeAt(env, path);
  if (node === null) return null;
  const profile = profileFor(registry, node);
  if (side === 'right' && profile.children === 'slots' && profile.enterRight !== undefined) {
    const slot = edgeTargetSlot(profile, node, profile.enterRight);
    if (slot !== null) {
      return slotValue(node, slot) === null
        ? { kind: 'slot', path, slot }
        : bench(env, [...path, slot], 'right', registry);
    }
  }
  return bench(env, path, side, registry);
}

/** The enterRight lookup with the filledOnly semantics (an inactive
 *  override slot degrades to the flow default). */
function edgeTargetSlot(profile: NavProfile, owner: NodeJson, slot: SlotName): SlotName | null {
  if (!hasSlot(owner, slot)) return null;
  if ((profile.filledOnly ?? []).includes(slot) && slotValue(owner, slot) === null) return null;
  return slot;
}

/**
 * The END of a region's content for VERTICAL arrival with no remembered
 * position (OA-vertical-default, owner-ratified 2026-11-09: "the caret
 * stops at the first possible resting position") — diving through
 * wrappers (groups gut to the interior content end, bare rows to their
 * single end) but never INTO a fenceless 2D structure: a row whose tail
 * cell is a frac/pow/root/fence rests at the seam RIGHT AFTER it; a bare
 * such structure in a slot lands at its last flow slot's content end (the
 * visual coincidence of its whole end). Tokens end in-token.
 */
function contentEnd(env: Envelope, path: Path, registry: NavRegistry): Caret | null {
  const node = nodeAt(env, path);
  if (node === null) return null;
  switch (node.type) {
    case 'num':
    case 'sym':
    case 'unit': {
      const len = tokenText(node).length;
      return len > 0 ? { kind: 'token', path, index: len } : bench(env, path, 'left', registry);
    }
    case 'sub':
      return { kind: 'token', path, index: subLabelText(node, 'sub').length, label: 'sub' };
    case 'group': {
      const child = slotValue(node, 'child');
      return child === null ? { kind: 'slot', path, slot: 'child' } : contentEnd(env, [...path, 'child'], registry);
    }
    case 'frac':
    case 'pow':
    case 'root': {
      const profile = profileFor(registry, node);
      const flow = activeFlow(profile, node);
      // the frac's den / pow's exp are the flow ends; the root's end is its
      // radicand (the index is a front-top script)
      const slot = node.type === 'root' ? 'radicand' : flow[flow.length - 1];
      const content = slot !== undefined ? slotValue(node, slot) : null;
      return content === null && slot !== undefined
        ? { kind: 'slot', path, slot }
        : slot === undefined
          ? null
          : contentEnd(env, [...path, slot], registry);
    }
    case 'op':
    case 'fn': {
      const args = rowArgs(node);
      if (args.length === 0) return { kind: 'row', path, index: 0 };
      const last = args[args.length - 1];
      if (last === null) return { kind: 'row', path, index: args.length - 1 };
      // fenceless 2D structures (and fence tokens) stop the dive: the seam
      // right after the structure IS the region's end ("first possible
      // resting position"); groups and rows keep diving.
      const t = last.type;
      if (t === 'frac' || t === 'pow' || t === 'root' || t === 'fence') {
        return { kind: 'row', path, index: args.length };
      }
      return contentEnd(env, [...path, args.length - 1], registry);
    }
    default:
      return bench(env, path, 'right', registry);
  }
}

/**
 * The station at the root row's visual border (the collapsed end position,
 * OA-visual-trumps): a text-like last/first cell ends IN-TOKEN (its end IS
 * the row end — no second state paints elsewhere); a null pending cell and
 * every fenced/fenceless structure (whose extent exceeds its content end)
 * keep the seam state (the after-structure station D5 fires from, and the
 * pending operand's own spot). The caller's same-state clamp turns a
 * collapsed station equal to the origin into the N3 no-op.
 */
export function rowEndStation(env: Envelope, ownerPath: Path, dir: Side, registry: NavRegistry): Caret | null {
  const owner = nodeAt(env, ownerPath);
  if (owner === null || !isRowNode(owner)) return null;
  const args = rowArgs(owner);
  if (args.length === 0) return { kind: 'row', path: ownerPath, index: 0 };
  const i = dir === 'right' ? args.length - 1 : 0;
  const cell = args[i];
  if (cell === null) return { kind: 'row', path: ownerPath, index: i };
  if (textLikeEnd(cell) || cell.type === 'unit') {
    return bench(env, [...ownerPath, i], dir, registry);
  }
  // a structure/fence/fenced boundary cell keeps the seam state
  return { kind: 'row', path: ownerPath, index: dir === 'right' ? args.length : 0 };
}

/**
 * The station a programmatic insertion places its caret at: the entry into
 * the node at `path` from side — T9's ruled radicand start ("the caret sits
 * at the beginning of the radicand"); rework 4a: the bench station (in-token
 * offsets for text tokens — T7's right-slot rule (`12|3` + `/` lands at
 * `3`'s offset 0) — a sub's label edges, a unit's label side, the content
 * stations of containers).
 */
export function entryStation(
  env: Envelope,
  path: Path,
  side: Side,
  registry: NavRegistry = NAV_PROFILES,
): Caret | null {
  // Rework 4a: the entry station is the bench station — in-token offsets
  // for text tokens (T7's right-slot rule, `12|3` + `/` lands caret at `3`'s
  // offset 0), a sub's label edges (T9), a unit's label side (S-104), the
  // content stations of containers.
  return bench(env, path, side, registry);
}

// ——— The climb: a position hands its direction up to the parent's geography ———

/** Movement leaving the node at `path` (as a unit standing at one of its
 *  parent's positions) direction `dir`. Each level resolves or hands the
 *  climb one level up; exhausting the spine at a bare non-row root rests
 *  at the whole-structure border station (the additive node `side` field,
 *  4a) — the document edge returns null (the N3 no-op). */
function climb(env: Envelope, path: Path, dir: NavDir, registry: NavRegistry): Caret | null {
  if (path.length === 0) {
    // The spine exhausted AT the bare non-row root: `side` border stations
    // (owner ruling 2026-11-09 — "add the two positions"). Root rows and
    // fn roots handle their own ends in the row-overflow branch below;
    // a lone token's in-token end IS its end; vertical keys never step
    // out (N6).
    if (dir !== 'left' && dir !== 'right') return null;
    const node = env.root;
    if (node === null) return null;
    const t = node.type;
    if (t === 'group' || t === 'fn' || t === 'frac' || t === 'pow' || t === 'root') {
      return { kind: 'node', path: [], side: dir === 'right' ? 'right' : 'left' };
    }
    return null;
  }
  const ownerPath = path.slice(0, -1);
  const step = path[path.length - 1];
  const owner = nodeAt(env, ownerPath);
  if (owner === null) return null;
  const profile = profileFor(registry, owner);

  if (dir === 'up' || dir === 'down') {
    const to = typeof step === 'string' ? edgeTo(profile, owner, step, dir) : null;
    return to === null
      ? climb(env, ownerPath, dir, registry)
      : arriveAtSlot(env, owner, ownerPath, to, dir, registry);
  }

  if (typeof step === 'number' && isRowNode(owner)) {
    // The exited child is cell `step` of an args row: horizontal flow
    // continues at the neighboring cell — a gap (a pending null) is a rest
    // station, a filled cell is dived at its bench — or exits the row when
    // the row runs out. At the root row the border collapses onto the
    // visual end (OA-visual-trumps): a text-like end cell's in-token end
    // IS the row end (a press there reproduces the origin's state — the
    // reducer's same-state clamp makes it the N3 no-op), a structure
    // boundary keeps the seam (the D5 after-station, the pending cell). A
    // fenced fn root steps past its close fence to the after-station
    // instead. Horizontal entry still dives deep (dive-through unchanged).
    const args = rowArgs(owner);
    const next = step + (dir === 'right' ? 1 : -1);
    if (next < 0 || next >= args.length) {
      if (ownerPath.length === 0) {
        if (owner.type === 'fn') {
          return { kind: 'node', path: [], side: dir === 'right' ? 'right' : 'left' };
        }
        const side: Side = dir === 'right' ? 'right' : 'left';
        return rowEndStation(env, ownerPath, side, registry);
      }
      return climb(env, ownerPath, dir, registry);
    }
    if (args[next] === null) return { kind: 'row', path: ownerPath, index: next };
    return enterFromSide(env, [...ownerPath, next], dir === 'right' ? 'left' : 'right', registry);
  }

  if (typeof step === 'string') {
    const to = edgeTo(profile, owner, step, dir);
    if (to !== null) {
      const arrival = arriveAtSlot(env, owner, ownerPath, to, dir, registry);
      if (arrival !== null) return arrival;
    }
    return climb(env, ownerPath, dir, registry);
  }
  return climb(env, ownerPath, dir, registry);
}

// ——— The resolver ———
//
// Position dispatch by caret kind:
// - empty  → the document edge: no target in any direction.
// - node   → the station on the node: a leaf/horizontal-overflow asks the
//            parent's geography (climb); a container entered horizontally
//            dives to its leftmost/rightmost station; up/down from any node
//            climbs as a position of its parent.
// - slot   → resting in an empty slot: the owner's edges answer first, then
//            the climb.
// - row    → an args-row insertion boundary k: the neighboring cell on the
//            horizontal side (dived when filled; when the cell at k is
//            empty the caret sits IN it and moves past it); up/down climbs
//            the row as a whole.

/** The station directly OUTSIDE the node at `path` on side `dir` — the climb
 *  the node's own station hands the direction to (the click-to-exit target:
 *  e.g. just right of a group's closing paren = the station after the group).
 *  Null at the document edge. */
export function exitStation(
  env: Envelope,
  path: Path,
  dir: NavDir,
  registry: NavRegistry = NAV_PROFILES,
): Caret | null {
  return climb(env, path, dir, registry);
}

/**
 * Resolve one relative movement against an envelope. Returns the target
 * caret, or null when the movement has no target (a defined no-op). Pure:
 * never mutates the envelope, never throws.
 */
export function resolveMove(
  env: Envelope,
  caret: Caret,
  dir: NavDir,
  registry: NavRegistry = NAV_PROFILES,
): Caret | null {
  switch (caret.kind) {
    case 'empty':
      return null;

    case 'node': {
      const node = nodeAt(env, caret.path);
      if (node === null) return null;
      if (caret.side !== undefined) {
        // The whole-structure border station of a lone non-row root (4a):
        // a press outward is the N3 no-op; a press inward re-enters at the
        // ruled interface (← into the fraction's num end, S-094; → at
        // the before-station enters the flow head, S-042).
        if (caret.side === 'right') {
          return dir === 'left' ? enterFromSide(env, caret.path, 'right', registry) : null;
        }
        return dir === 'right' ? bench(env, caret.path, 'left', registry) : null;
      }
      const profile = profileFor(registry, node);
      if (dir === 'left' || dir === 'right') {
        if (profile.children === 'leaf') return climb(env, caret.path, dir, registry);
        return dir === 'right'
          ? bench(env, caret.path, 'left', registry)
          : enterFromSide(env, caret.path, 'right', registry);
      }
      return climb(env, caret.path, dir, registry);
    }

    case 'slot': {
      const owner = nodeAt(env, caret.path);
      if (owner === null) return null;
      const profile = profileFor(registry, owner);
      const to = edgeTo(profile, owner, caret.slot, dir);
      if (to !== null) {
        const arrival = arriveAtSlot(env, owner, caret.path, to, dir, registry);
        if (arrival !== null) return arrival;
      }
      return climb(env, caret.path, dir, registry);
    }

    case 'row': {
      const row = nodeAt(env, caret.path);
      if (row === null || !isRowNode(row)) return null;
      const args = rowArgs(row);
      if (dir === 'up' || dir === 'down') return climb(env, caret.path, dir, registry);
      if (dir === 'right') {
        if (caret.index >= args.length) return climb(env, caret.path, dir, registry);
        if (args[caret.index] !== null) return bench(env, [...caret.path, caret.index], 'left', registry);
        // The caret sits IN the empty cell at its index: moving right leaves
        // it for the next cell (or the next gap, or the row's right exit).
        const next = caret.index + 1;
        if (next >= args.length) return climb(env, caret.path, dir, registry);
        return args[next] === null
          ? { kind: 'row', path: caret.path, index: next }
          : bench(env, [...caret.path, next], 'left', registry);
      }
      if (caret.index <= 0) return climb(env, caret.path, dir, registry);
      const prev = caret.index - 1;
      return args[prev] === null
        ? { kind: 'row', path: caret.path, index: prev }
        : enterFromSide(env, [...caret.path, prev], 'right', registry);
    }

    case 'token': {
      const node = nodeAt(env, caret.path);
      if (node === null) return null;
      if (node.type === 'sub') {
        // A subscript's label strings are addressed one at a time (T9
        // vocabulary ruling): Left/Right step within the addressed label and
        // cross base↔script at their seam (the visual reading order) — out
        // of the sub entirely only past the outer ends. Vertical keys: the
        // sub is a leaf, the climb answers.
        const label = caret.label;
        if (label !== 'base' && label !== 'sub') return null;
        const text = subLabelText(node, label);
        const len = text.length;
        if (!Number.isInteger(caret.index) || caret.index < 0 || caret.index > len) return null;
        if (dir === 'left') {
          if (caret.index > 0) return { kind: 'token', path: caret.path, index: caret.index - 1, label };
          if (label === 'sub') {
            return { kind: 'token', path: caret.path, index: subLabelText(node, 'base').length, label: 'base' };
          }
          return climb(env, caret.path, 'left', registry);
        }
        if (dir === 'right') {
          if (caret.index < len) return { kind: 'token', path: caret.path, index: caret.index + 1, label };
          if (label === 'base') return { kind: 'token', path: caret.path, index: 0, label: 'sub' };
          return climb(env, caret.path, 'right', registry);
        }
        return climb(env, caret.path, dir, registry);
      }
      // Inside a num, sym, or unit-label token (rework 2a: symbols join
      // numbers — N1; rework 2b-2: unit labels — S-104; every other leaf
      // stays atomic). Left/Right step one character; at the ends they exit
      // to the adjacent structural stations (the climb the node caret would
      // do). Vertical keys behave like the token's owning structural station
      // for the move itself.
      if (!isTokenNode(node)) return null;
      const len = tokenText(node).length;
      if (!Number.isInteger(caret.index) || caret.index < 0 || caret.index > len) return null;
      if (dir === 'left') {
        return caret.index > 0
          ? { kind: 'token', path: caret.path, index: caret.index - 1 }
          : climb(env, caret.path, 'left', registry);
      }
      if (dir === 'right') {
        return caret.index < len
          ? { kind: 'token', path: caret.path, index: caret.index + 1 }
          : climb(env, caret.path, 'right', registry);
      }
      return climb(env, caret.path, dir, registry);
    }
  }
}
