// Vertical positional memory V2 (editor-layer state, pure, never logged) —
// the keyboard-layer replacement for pixel x-conservation. Supersedes the
// session-2 model entirely: no directions, no jump-back firing, no fire rules,
// and NO clearing of any kind — typed ops, undo, redo, clicks, backspace never
// clear anything.
//
// For every parent with vertically aligned children (per the nav profiles'
// vertical edges — frac num/den, pow base/exp, root radicand/index, …) the
// memory keeps ONE stored caret position per child region, keyed by
// (parent path, slot) — path-keyed, never DOM, so it is immune to the
// controller's full rebuilds:
//   - WRITE: a vertical keypress that is about to move the caret OUT of a
//     region stores the current position (in-token index included) in that
//     region's entry. A vertical press that no-ops writes nothing.
//   - READ: a vertical keypress ARRIVING in a region uses the stored position
//     when it still resolves in the current tree (caretResolvesIn-validated);
//     stored wins over the structural default whenever it resolves. A stored
//     position that no longer resolves is discarded and the structural
//     default is used — nothing is ever proactively cleared.
// Ping-pong is symmetric by construction (the return trip leaves the other
// region, storing its spot); horizontal movement never disturbs any store;
// deep origins fire (the store is region-level, so a leaf deep inside a
// numerator region retraces to itself). Clicks write no entries.

import type { Envelope, NodeJson } from '../ast/json.js';

import {
  NAV_PROFILES,
  caretResolvesIn,
  nodeAt,
  resolveMove,
  type Caret,
  type NavDir,
  type NavRegistry,
  type Path,
  type SlotName,
} from '../engine/index.js';

/** One child region of a vertically aligned parent: the parent's path + slot. */
export interface MemoryRegion {
  readonly parentPath: Path;
  readonly slot: SlotName;
}

/** Stable map key for a region (paths are JSON arrays; rebuild-immune). */
export const regionKey = (region: MemoryRegion): string => `${JSON.stringify(region.parentPath)}/${region.slot}`;

/** The memory map (owned by the controller; the helpers here are pure and
 *  return fresh maps): region key → stored caret position. */
export type VerticalMemory = Map<string, Caret>;

/** True iff the owner's nav profile has a vertical edge FROM `slot` (the
 *  slot is one of the parent's vertically aligned regions). */
function hasVerticalEdge(registry: NavRegistry, owner: NodeJson, slot: SlotName): boolean {
  const profile = registry[owner.type];
  return (profile?.vertical ?? []).some((edge) => edge.from === slot);
}

/** The region the caret sits in: the deepest slot-entry on the caret's path
 *  whose parent has a vertical edge from that slot. Slot carets address their
 *  region directly; row/node/token carets scan their path from the end.
 *  Null for the empty-formula caret and for positions outside any vertically
 *  aligned region (group children, unit values, row seams, the root itself). */
export function regionOf(env: Envelope, caret: Caret, registry: NavRegistry = NAV_PROFILES): MemoryRegion | null {
  if (caret.kind === 'empty') return null;
  const path: readonly (number | SlotName)[] =
    caret.kind === 'slot' ? [...caret.path, caret.slot] : caret.path;
  for (let k = path.length - 1; k >= 0; k--) {
    const step = path[k];
    if (typeof step !== 'string') continue;
    const parent = nodeAt(env, path.slice(0, k) as Path);
    if (parent !== null && hasVerticalEdge(registry, parent, step)) {
      return { parentPath: path.slice(0, k) as Path, slot: step };
    }
  }
  return null;
}

const sameCaret = (a: Caret, b: Caret): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface VerticalKeyResult {
  readonly caret: Caret;
  readonly mem: VerticalMemory;
  /** True when the arrival region's stored position won over the structural target. */
  readonly fired: boolean;
}

/** One vertical key press, resolved purely (nothing applied, nothing logged):
 *  the structural move target is computed first; a press with no target (or
 *  a target equal to the caret) is a no-op and writes nothing. Otherwise the
 *  region being left stores the current caret, and the arrival region's stored
 *  caret wins when it still resolves in this tree (a dangling store is
 *  discarded and the structural target is used). */
export function applyVerticalKey(env: Envelope, caret: Caret, dir: NavDir, mem: VerticalMemory): VerticalKeyResult {
  const target = resolveMove(env, caret, dir);
  if (target === null || sameCaret(target, caret)) return { caret, mem, fired: false };
  const next: VerticalMemory = new Map(mem);
  const from = regionOf(env, caret);
  if (from !== null) next.set(regionKey(from), caret);
  const to = regionOf(env, target);
  if (to !== null && (from === null || regionKey(to) !== regionKey(from))) {
    const key = regionKey(to);
    const entry = next.get(key);
    if (entry !== undefined) {
      if (caretResolvesIn(env, entry)) return { caret: entry, mem: next, fired: true };
      next.delete(key); // dangling store: discard, structural default wins
    }
  }
  return { caret: target, mem: next, fired: false };
}
