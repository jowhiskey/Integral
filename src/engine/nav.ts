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
  hasSlot,
  isRowNode,
  isTokenNode,
  nodeAt,
  refOfPath,
  rowArgs,
  sameCaret,
  slotValue,
  subLabelText,
  tokenText,
  type Caret,
  type Path,
  type Ref,
  type SlotName,
  type SubLabel,
} from './caret.js';
import { edgeCell, isImplicitRow } from './internal.js';

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

/** A `filledOnly` entry: a plain slot name keeps the original meaning
 *  (active only when the slot is filled); `{ slot, unlessNodeFlag }` adds
 *  rework-4b-1's exception (OA-index-horizontal): the slot is REAL
 *  geography whenever the node carries the additive flag, even when empty
 *  (`mroot: true` marks the empty □ index — without the flag an omitted
 *  index is a complete square root with no index geography). */
export interface FilledOnlyRule {
  readonly slot: SlotName;
  readonly unlessNodeFlag?: string;
}

/** A `filledOnly` slot that is geography only when filled — conditionally,
 *  per `FilledOnlyRule`. */
export type FilledOnly = SlotName | FilledOnlyRule;

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
  /** Flow slots that are part of the geography only when filled (`FilledOnly`
   *  rules) — a square root's omitted index is a complete tree with no index
   *  geography; an mroot's □ index IS geography (OA-index-horizontal). */
  readonly filledOnly?: readonly FilledOnly[];
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
  // index is a HORIZONTAL position too (OA-index-horizontal, 4b-1): it sits
  // at the root's LEFT boundary, so ← at the radicand's start steps back
  // into the index and → out of the index crosses into the radicand (the
  // index only where it is real geography — a filled slot or the mroot □).
  // The RIGHT boundary rides the radicand — the index is a front-top
  // script, so ← into a root lands at the radicand's end (S-094).
  root: {
    children: 'slots',
    flow: ['index', 'radicand'],
    filledOnly: [{ slot: 'index', unlessNodeFlag: 'mroot' }],
    horizontal: [
      { from: 'index', dir: 'right', to: 'radicand' },
      { from: 'radicand', dir: 'left', to: 'index' },
    ],
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

/** True iff `slot` is an ACTIVE flow/geography slot of `node` under the
 *  profile's `filledOnly` rules — filled when required, real geography for
 *  a `FilledOnlyRule` whenever the node carries its exception flag (the
 *  mroot □ index, OA-index-horizontal). Slots without a rule are always
 *  active. */
function slotActive(profile: NavProfile, node: NodeJson, slot: SlotName): boolean {
  if (!hasSlot(node, slot)) return false;
  for (const rule of profile.filledOnly ?? []) {
    if (typeof rule === 'string' ? rule === slot : rule.slot === slot) {
      if (typeof rule !== 'string' && rule.unlessNodeFlag !== undefined) {
        if ((node as unknown as Record<string, unknown>)[rule.unlessNodeFlag] === true) return true;
      }
      return slotValue(node, slot) !== null;
    }
  }
  return true;
}

/** The traversal-flow slots of `node` that are active: owned by the type and
 *  filled when required (`filledOnly`, incl. the mroot □-index exception). */
function activeFlow(profile: NavProfile, node: NodeJson): SlotName[] {
  return (profile.flow ?? []).filter((slot) => slotActive(profile, node, slot));
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
    if (!slotActive(profile, owner, edge.to)) continue;
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

// ——— Flank stations (rework 4b-1 — OA-flank-stations) ———
//
// The positions directly against a whole container's left/right edges in
// mid-row glyph zones are restable, insertable stations (owner amendment,
// binding): crossing a separator glyph INTO a container cell rests at the
// flank instead of diving; exiting a container through a glyph zone rests
// there before the neighbor's content continues. Slot/root boundaries
// carry the same station (4a's OA-lone-root-stations at the root). Row
// starts/ends keep their existing seam stations: a structure cell at the
// row border has no glyph zone of its own, and end-of-row
// after-structures keep the seam (the M-09 D5 pin). Implicit rows render
// no glyphs: their glyph-less adjacency zones stay merged (N2 — no flank
// states there).

/** Whole containers that own flank stations: fenced group/fn, the
 *  fenceless 2D frac/pow/root, and the subscript (OA-flank-stations names
 *  every structure kind; `sub` widened in 4b-1 — a LONE sub never produces
 *  one, so the 4a lone-root behavior stands there). */
function isFlankable(node: NodeJson): boolean {
  const t = node.type;
  return t === 'group' || t === 'fn' || t === 'frac' || t === 'pow' || t === 'root' || t === 'sub';
}

/** The bare-root border station (4a's lone-root stations): right for
 *  group/fn/frac/pow/root, left for group/fn/frac/root (the lone pow's
 *  before-station is retired, T-11); null otherwise. */
function loneRootBorder(node: NodeJson, dir: Side): Caret | null {
  const t = node.type;
  if (dir === 'right') {
    return t === 'group' || t === 'fn' || t === 'frac' || t === 'pow' || t === 'root'
      ? { kind: 'node', path: [], side: 'right' }
      : null;
  }
  return t === 'group' || t === 'fn' || t === 'frac' || t === 'root'
    ? { kind: 'node', path: [], side: 'left' }
    : null;
}

/** True iff the args row draws a separator at the boundary on `side` of
 *  cell `i` (explicit op glyphs and fn commas; implicit rows and the row
 *  borders have none). */
function hasSeparatorAt(row: NodeJson, i: number, side: Side): boolean {
  if (row.type !== 'op' && row.type !== 'fn') return false;
  if (isImplicitRow(row)) return false;
  const args = rowArgs(row);
  return side === 'left' ? i > 0 && i < args.length : i >= 0 && i < args.length - 1;
}

/** The side station of the args cell at `cellPath`, when its boundary on
 *  `side` carries a visible separator (the mid-row glyph zone); null
 *  otherwise (the row border keeps its seam station). */
function cellFlank(env: Envelope, cellPath: Path, side: Side): Caret | null {
  const ref = refOfPath(cellPath);
  if (ref.at !== 'cell') return null;
  const row = nodeAt(env, ref.path);
  const cell = nodeAt(env, cellPath);
  if (row === null || cell === null || !isFlankable(cell)) return null;
  if (!hasSeparatorAt(row, ref.index, side)) return null;
  return { kind: 'node', path: cellPath, side };
}

/** The container-exit flank of 4b-1: a horizontal exit whose slot has no
 *  further edge leaves the container and rests at its flank when a glyph
 *  zone or slot/root boundary stands on the exit side. Row-border cells
 *  (no separator) keep the climb (the end-of-row seam, the N3 ends).
 *  At a bare root the 4a lone-root stations govern, with one 4b-1 fix for
 *  OA-visual-trumps (the T-11 twin elimination): the pow's before-station
 *  painted exactly at its in-line base's start, so it is retired — ← out
 *  of a lone power's base is the N3 no-op; `sub` stays out (leaf ends). */
function containerExitFlank(env: Envelope, owner: NodeJson, ownerPath: Path, dir: Side): Caret | null {
  if (!isFlankable(owner)) return null;

  if (ownerPath.length === 0) return loneRootBorder(owner, dir);
  // A slot boundary carries its own flank (a slot holds exactly one node —
  // its content edge IS the slot edge; the M-12 group's pre-/post-fence
  // stations, OA-fence-flank); an args cell only when its boundary glyph
  // zone exists (the mid-row flanks), else the climb continues.
  const ref = refOfPath(ownerPath);
  if (ref.at === 'slot') return { kind: 'node', path: ownerPath, side: dir };
  return cellFlank(env, ownerPath, dir);
}

/** True iff the node is a text-like in-token token (num/sym tokens, sub label runs, unit labels): its in-token end
 *  IS its visual right edge (OA-visual-trumps — no seam/station beyond it). */
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
      return tokenEdgeCaret(path, node, side);
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

/** The in-token edge station of a text-like token. */
const tokenEdgeCaret = (path: Path, node: NodeJson, side: Side): Caret => ({
  kind: 'token',
  path,
  index: side === 'left' ? 0 : tokenText(node).length,
});

/** Entering the node at `path` from an adjacent row position: consults the
 *  profile's `enterRight` override on the right side (N5/S-094 — a fraction's
 *  horizontal interface is the numerator on BOTH edges, a root's right
 *  boundary its radicand); everything else benches. Exported for deletion
 *  landings that rest at a cell's right edge (B-33 (2): the bonded pair's
 *  left operand). */
export function enterFromSide(env: Envelope, path: Path, side: Side, registry: NavRegistry = NAV_PROFILES): Caret | null {
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

/** The enterRight lookup with the filledOnly rules (an inactive override
 *  slot degrades to the flow default). */
function edgeTargetSlot(profile: NavProfile, owner: NodeJson, slot: SlotName): SlotName | null {
  return slotActive(profile, owner, slot) ? slot : null;
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
      return len > 0 ? tokenEdgeCaret(path, node, 'right') : bench(env, path, 'left', registry);
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
  // OA-visual-trumps twin collapse (consolidated cleanup): an op-row BORDER
  // cell is transparent at the row's edge — the row's border seam IS the
  // nested row's edge-cell station, so a text-like/unit edge cell collapses
  // onto its in-token/bench station (the `row [] #0` vs `token [0] @0` and
  // `row [0] #0` vs `row [] #0` pairs — glyph-less pairs included). A nested
  // row ending in a structure keeps the outer seam (same rule as a direct
  // structure cell below).
  if (cell.type === 'op') {
    const edge = edgeCell(env, [...ownerPath, i], dir === 'right' ? 'last' : 'first');
    if (edge.node !== null && (textLikeEnd(edge.node) || edge.node.type === 'unit')) {
      return bench(env, edge.path, dir, registry);
    }
  }
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
    // out (N6). 4b-1 (OA-visual-trumps, the T-11 twin elimination): a
    // lone power's BEFORE-station painted exactly at its in-line base's
    // start — it is retired; base@0's ← is the N3 no-op (the side:'right'
    // after-station stands: the D5/S-094/N3 rules of 4a keep it).
    if (dir !== 'left' && dir !== 'right') return null;
    const node = env.root;
    if (node === null) return null;
    return loneRootBorder(node, dir);
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
      // 4b-1 (OA-fence-flank): leaving an FN row horizontally crosses its
      // closing fence — the whole-cell flank (the post-`)` station) rests
      // there first when the fn sits mid-row; a plain op row has no flank,
      // the overflow climbs (4a).
      if (dir === 'left' || dir === 'right') {
        const flank = containerExitFlank(env, owner, ownerPath, dir);
        if (flank !== null) return flank;
      }
      return climb(env, ownerPath, dir, registry);
    }
    if (args[next] === null) return { kind: 'row', path: ownerPath, index: next };
    // 4b-1 OA-flank-stations: crossing the separator glyph INTO a whole
    // container cell rests at its flank — the station directly against the
    // structure's edge (typing inserts directly adjacent, D5 fires from
    // the right edge) — instead of diving.
    const enterSide: Side = dir === 'right' ? 'left' : 'right';
    const flank = cellFlank(env, [...ownerPath, next], enterSide);
    if (flank !== null) return flank;
    return enterFromSide(env, [...ownerPath, next], enterSide, registry);
  }

  if (typeof step === 'string') {
    const to = edgeTo(profile, owner, step, dir);
    if (to !== null) {
      const arrival = arriveAtSlot(env, owner, ownerPath, to, dir, registry);
      if (arrival !== null) return arrival;
    }
    // 4b-1 (I-19): a unit's value slot flows right into its LABEL — the
    // granular unit's own text channel chain (S-104): the value→label walk
    // link that was missing (out of the value, into the label letters).
    if (owner.type === 'unit' && step === 'value' && dir === 'right') {
      const label = tokenText(owner);
      if (label.length > 0) return { kind: 'token', path: ownerPath, index: 0 };
    }
    // 4b-1 OA-flank-stations: a horizontal slot exit with no further edge
    // leaves the container and rests at its flank when a glyph zone / slot
    // boundary stands on the exit side (mid-row and slot containers; the
    // bare-root rules of 4a above).
    if (dir === 'left' || dir === 'right') {
      const flank = containerExitFlank(env, owner, ownerPath, dir);
      if (flank !== null) return flank;
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
 * The station AT the whole container's own edge on `side` (rework 4b-2, the
 * click layer's C1 target): the glyph-zone flank station mid-row
 * (OA-flank-stations / OA-fence-flank — `node` with `side`), the slot-boundary
 * station in a slot, the lone-root border station (OA-lone-root-stations), or
 * — at a row border with no glyph zone of its own — the row's border seam.
 * Null for non-flankable nodes (rows, tokens) and at the document edge of a
 * bare non-flankable root.
 */
export function edgeStation(env: Envelope, path: Path, side: 'left' | 'right'): Caret | null {
  const node = nodeAt(env, path);
  if (node === null || !isFlankable(node)) return null;
  const flank = containerExitFlank(env, node, path, side);
  if (flank !== null) return flank;
  // a row-border cell of a flankable container: no glyph zone — the row's
  // border seam is the edge station
  const ref = refOfPath(path);
  if (ref.at === 'cell') {
    return { kind: 'row', path: ref.path, index: side === 'left' ? ref.index : ref.index + 1 };
  }
  return null;
}

/** One horizontal step of an args-row caret: the neighboring cell on the
 *  side (dived when filled, a pending null rests as its seam) or the climb
 *  when the row runs out. */
function rowStep(
  env: Envelope,
  caret: Extract<Caret, { kind: 'row' }>,
  dir: 'left' | 'right',
  registry: NavRegistry,
): Caret | null {
  const row = nodeAt(env, caret.path);
  if (row === null || !isRowNode(row)) return null;
  const args = rowArgs(row);
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
        // The flank/border station of a whole container (4a at lone roots,
        // 4b-1 everywhere else): a press inward re-enters at the ruled
        // interface (← into the fraction's num end, S-094; → at the
        // left-side station enters the flow head); a press outward leaves
        // it — at a bare root that is the N3 no-op, elsewhere the climb
        // continues to the neighbor cell. Vertical keys climb the
        // container's cell position (the parent's geography), never the
        // flank's horizontal rules.
        if (dir === 'up' || dir === 'down') return climb(env, caret.path, dir, registry);
        if (caret.side === 'right') {
          if (dir === 'left') return enterFromSide(env, caret.path, 'right', registry);
          return caret.path.length === 0 ? null : climb(env, caret.path, 'right', registry);
        }
        if (dir === 'right') return bench(env, caret.path, 'left', registry);
        return caret.path.length === 0 ? null : climb(env, caret.path, 'left', registry);
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
      // 4b-1: the empty slot IS the region's station (N8) — its climb hands
      // the direction up THROUGH the slot (the container's own exit rules
      // apply: exiting a structure horizontally rests at its flank before
      // the neighbor cell rides on).
      return climb(env, [...caret.path, caret.slot], dir, registry);
    }

    case 'row': {
      const row = nodeAt(env, caret.path);
      if (row === null || !isRowNode(row)) return null;
      if (dir === 'up' || dir === 'down') return climb(env, caret.path, dir, registry);
      return rowStep(env, caret, dir, registry);
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
          // The base label's offset 0 IS the sub's left edge (4b-1): a
          // glyph zone to its left rests at the L-flank station, else the
          // climb out (OA-flank-stations).
          const baseFlank = cellFlank(env, caret.path, 'left');
          if (baseFlank !== null) return baseFlank;
          return climb(env, caret.path, 'left', registry);
        }
        if (dir === 'right') {
          if (caret.index < len) return { kind: 'token', path: caret.path, index: caret.index + 1, label };
          if (label === 'base') return { kind: 'token', path: caret.path, index: 0, label: 'sub' };
          // The script label's end IS the sub's right edge (4b-1): a glyph
          // zone to its right rests at the R-flank station, else the climb.
          const scriptFlank = cellFlank(env, caret.path, 'right');
          if (scriptFlank !== null) return scriptFlank;
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
      // OA-unit-single-seam (ruled live 2026-11-10): the value/label boundary
      // is ONE seam (`50|mm`, the label's offset 0). Walking right out of a
      // unit's VALUE channel: from the last interior offset → the seam; from
      // the value's END (the seam's click-placed twin, e.g. right after a
      // typed digit grew the value) → straight past the seam to the label's
      // offset 1, so no press rests on the seam twice.
      if (dir === 'right') {
        const ref = refOfPath(caret.path);
        if (ref.at === 'slot' && ref.slot === 'value') {
          const owner = nodeAt(env, ref.path);
          const llen = owner !== null && owner.type === 'unit' ? tokenText(owner).length : 0;
          if (owner !== null && owner.type === 'unit' && llen > 0) {
            if (caret.index === len) return { kind: 'token', path: ref.path, index: Math.min(1, llen) };
            if (caret.index === len - 1) return { kind: 'token', path: ref.path, index: 0 };
          }
        }
      }
      if (dir === 'left') {
        if (caret.index > 0) return { kind: 'token', path: caret.path, index: caret.index - 1 };
        // 4b-1 (I-19): a unit label's offset 0 continues back into the
        // VALUE (the granular unit walks value→label, S-104). Amended by
        // OA-unit-single-seam (ruled live 2026-11-10): the label's offset 0
        // IS the one value/label seam — ← from it steps to the value's last
        // INTERIOR offset (the value's end stop is the seam's twin, no
        // separate rest): `|50 mm` `5|0 mm` `50|mm` `50 m|m` `50 mm|`.
        if (node.type === 'unit') {
          const value = slotValue(node, 'value');
          if (tokenText(node).length > 0 && value !== null && isTokenNode(value)) {
            const vlen = tokenText(value).length;
            return { kind: 'token', path: [...caret.path, 'value'], index: Math.max(vlen - 1, 0) };
          }
          if (value === null) return { kind: 'slot', path: caret.path, slot: 'value' };
          const into = bench(env, [...caret.path, 'value'], 'right', registry);
          if (into !== null) return into;
        }
        return climb(env, caret.path, 'left', registry);
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

// ——— Home/End (K1, rework session 5): local boundary first, then iterative outward ———
//
// K1 (S-089/S-090/S-091, S-105 A): Home/End jump to the start/end of the
// CURRENT row/slot (the innermost enclosing region — inside a slot that is
// the slot's own row, never a sibling slot). Pressed again when already at
// that boundary they escalate ONE level outward per press — DIRECTLY to the
// start/end of the enclosing row (not first to the position after the
// structure) — iterating to the formula start/end, where further presses are
// defined no-ops. The region chain is derived from the caret's address; the
// boundary of a region is the same visual station the row/token/edge rules
// already produce (rowEndStation / in-token offsets / edgeStation).

/** A region of the caret geography for Home/End: a row, a slot, a token, or
 *  a bare node — innermost first, ending at the formula root. */
type BoundaryRegion =
  | { readonly kind: 'row'; readonly path: Path }
  | { readonly kind: 'slot'; readonly path: Path; readonly slot: SlotName }
  | { readonly kind: 'token'; readonly path: Path; readonly label?: SubLabel }
  | { readonly kind: 'node'; readonly path: Path };

/** The boundary station of the node at `path` seen as one unit: a row's own
 *  visual border (rowEndStation; a lone FN root's border is the station past
 *  its close fence, mirroring the climb's fn-root rule), a token's in-token
 *  edge, a whole container's edge station (edgeStation, falling back to the
 *  bench), the node caret for other leaves. */
function nodeRegionBoundary(env: Envelope, path: Path, side: Side, registry: NavRegistry): Caret | null {
  const node = nodeAt(env, path);
  if (node === null) return null;
  if (isRowNode(node)) {
    if (path.length === 0 && node.type === 'fn') {
      return { kind: 'node', path: [], side };
    }
    return rowEndStation(env, path, side, registry);
  }
  switch (node.type) {
    case 'num':
    case 'sym':
    case 'unit':
      return tokenEdgeCaret(path, node, side);
    case 'sub':
      return side === 'left'
        ? { kind: 'token', path, index: 0, label: 'base' }
        : { kind: 'token', path, index: subLabelText(node, 'sub').length, label: 'sub' };
    default:
      if (isFlankable(node)) return edgeStation(env, path, side) ?? bench(env, path, side, registry);
      return { kind: 'node', path };
  }
}

/** The start/end station of one region (its content's boundary for a slot). */
function regionBoundary(env: Envelope, region: BoundaryRegion, side: 'start' | 'end', registry: NavRegistry): Caret | null {
  const s: Side = side === 'start' ? 'left' : 'right';
  switch (region.kind) {
    case 'row':
      return rowEndStation(env, region.path, s, registry);
    case 'slot': {
      const owner = nodeAt(env, region.path);
      if (owner === null) return null;
      const content = slotValue(owner, region.slot);
      if (content === null) return { kind: 'slot', path: region.path, slot: region.slot };
      return nodeRegionBoundary(env, [...region.path, region.slot], s, registry);
    }
    case 'token': {
      const node = nodeAt(env, region.path);
      if (node === null) return null;
      const len = region.label !== undefined ? subLabelText(node, region.label).length : tokenText(node).length;
      const index = side === 'start' ? 0 : len;
      return region.label !== undefined
        ? { kind: 'token', path: region.path, index, label: region.label }
        : { kind: 'token', path: region.path, index };
    }
    case 'node':
      // a bare node region (a leaf, or the formula root itself): the node's
      // own unit boundary — row border for rows, in-token edge for tokens,
      // edge station for containers, the node caret for other leaves
      return nodeRegionBoundary(env, region.path, s, registry);
  }
}

/** The region chain of a caret, innermost first, ending at the formula root
 *  (a `node` region at path [] — whose boundary is the root's own row border /
 *  in-token edge / lone-container side station). A slot region chains into
 *  the owner's HORIZONTALLY-linked sibling slots (the pow's base→exp and the
 *  root's index→radicand chains are one visual row — the N4/N5 horizontal
 *  interface); stacked layouts (frac num/den) have no horizontal edge, so
 *  they never chain — Home/End never dives into a stacked sibling slot. */
function boundaryRegions(env: Envelope, caret: Caret, side: 'start' | 'end', registry: NavRegistry): BoundaryRegion[] {
  const out: BoundaryRegion[] = [];
  const dir: NavDir = side === 'start' ? 'left' : 'right';
  const pushSlot = (ownerPath: Path, slot: SlotName): void => {
    out.push({ kind: 'slot', path: ownerPath, slot });
    const owner = nodeAt(env, ownerPath);
    if (owner !== null) {
      const edge = edgeTo(profileFor(registry, owner), owner, slot, dir);
      if (edge !== null) {
        pushSlot(ownerPath, edge); // the horizontal chain continues in the owner
        return;
      }
    }
    pushRef(refOfPath(ownerPath));
  };
  const pushRef = (ref: Ref): void => {
    if (ref.at === 'root') out.push({ kind: 'node', path: [] });
    else if (ref.at === 'cell') {
      out.push({ kind: 'row', path: ref.path });
      pushRef(refOfPath(ref.path));
    } else {
      pushSlot(ref.path, ref.slot);
    }
  };
  switch (caret.kind) {
    case 'empty':
      break; // empty formula: the caller no-ops
    case 'row':
      out.push({ kind: 'row', path: caret.path });
      pushRef(refOfPath(caret.path));
      break;
    case 'slot':
      pushSlot(caret.path, caret.slot);
      break;
    case 'token':
      out.push({ kind: 'token', path: caret.path, label: caret.label });
      pushRef(refOfPath(caret.path));
      break;
    case 'node': {
      const node = nodeAt(env, caret.path);
      if (node !== null && caret.side === undefined) {
        // a plain node caret: the node's own region (row or leaf)
        if (isRowNode(node)) out.push({ kind: 'row', path: caret.path });
        else out.push({ kind: 'node', path: caret.path });
      }
      // a flank/border station (side set) belongs to the parent's geography
      pushRef(refOfPath(caret.path));
      break;
    }
  }
  return out;
}

/**
 * Resolve one Home/End press (K1). Returns the target caret, or null when the
 *  caret is already at the outermost (formula) boundary — a defined no-op.
 *  The first region whose boundary differs from the caret wins: that is the
 *  local jump when inside a row/slot, and the one-level-per-press escalation
 *  (S-105 A: directly to the enclosing row's start/end) when already at the
 *  inner boundary. Pure: never mutates the envelope, never throws.
 */
export function resolveBoundary(
  env: Envelope,
  caret: Caret,
  side: 'start' | 'end',
  registry: NavRegistry = NAV_PROFILES,
): Caret | null {
  if (caret.kind === 'empty') return null;
  for (const region of boundaryRegions(env, caret, side, registry)) {
    const b = regionBoundary(env, region, side, registry);
    if (b !== null && !sameCaret(b, caret)) return b;
  }
  return null;
}
