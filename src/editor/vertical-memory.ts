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
  isRowNode,
  nodeAt,
  resolveMove,
  rowArgs,
  sameCaret,
  type Caret,
  type NavDir,
  type NavRegistry,
  type Path,
  type SlotName,
} from '../engine/index.js';
import { samePath } from '../engine/internal.js';

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

/** One exited structure's own layer memor(ies): the regions wiped on a
 *  sideways exit (OA-vmem-nesting) — the structure's own vertical slots. */
function ownRegions(registry: NavRegistry, env: Envelope, structurePath: Path): MemoryRegion[] {
  const node = nodeAt(env, structurePath);
  if (node === null) return [];
  const profile = registry[node.type];
  return (profile?.vertical ?? [])
    .filter((edge) => edge.from !== undefined)
    .map((edge) => ({ parentPath: structurePath, slot: edge.from }));
}

/** The caret's enclosing vertical regions, deepest first (every slot entry
 *  on its path whose parent has a vertical edge from that slot). */
function verticalRegions(env: Envelope, caret: Caret, registry: NavRegistry): MemoryRegion[] {
  if (caret.kind === 'empty') return [];
  const path: readonly (number | SlotName)[] =
    caret.kind === 'slot' ? [...caret.path, caret.slot] : caret.path;
  const out: MemoryRegion[] = [];
  for (let k = path.length - 1; k >= 0; k -= 1) {
    const step = path[k];
    if (typeof step !== 'string') continue;
    const parentPath = path.slice(0, k) as Path;
    const parent = nodeAt(env, parentPath);
    if (parent !== null && hasVerticalEdge(registry, parent, step) && !out.some((r) => samePath(r.parentPath, parentPath))) {
      out.push({ parentPath, slot: step });
    }
  }
  return out;
}

/**
 * 4b-1 (OA-vmem-nesting): the structures a ←/→ press EXITS. The ONE
 * clearing trigger the owner ruled: a horizontal press whose origin lives
 * inside a structure and whose target is outside it wipes that
 * structure's LAYER memory (its own region stores); vertical exits and
 * every other action never clear. A movable/no-op press exits nothing.
 */
export function exitedStructures(
  env: Envelope,
  from: Caret,
  to: Caret,
  registry: NavRegistry = NAV_PROFILES,
): MemoryRegion[] {
  const wiped: MemoryRegion[] = [];
  const toStructures = verticalRegions(env, to, registry).map((r) => r.parentPath);
  for (const region of verticalRegions(env, from, registry)) {
    const stillInside = toStructures.some((p) => samePath(p, region.parentPath));
    if (!stillInside) wiped.push(...ownRegions(registry, env, region.parentPath));
  }
  return wiped;
}

/** Apply the sideways-exit wipe (pure: fresh map). */
export function wipeSideways(
  env: Envelope,
  from: Caret,
  to: Caret,
  mem: VerticalMemory,
  registry: NavRegistry = NAV_PROFILES,
): VerticalMemory {
  const exited = exitedStructures(env, from, to, registry);
  if (exited.length === 0) return mem;
  const next = new Map(mem);
  for (const region of exited) next.delete(regionKey(region));
  return next;
}

/** The region the caret sits in: the deepest slot-entry on the caret's path
 *  whose parent has a vertical edge from that slot. Slot carets address their
 *  region directly; row/node/token carets scan their path from the end.
 *  Null for the empty-formula caret and for positions outside any vertically
 *  aligned region (group children, unit values, row seams, the root itself). */
export function regionOf(env: Envelope, caret: Caret, registry: NavRegistry = NAV_PROFILES): MemoryRegion | null {
  return verticalRegions(env, caret, registry)[0] ?? null;
}

/**
 * OA-vmem-nesting (4b-1, owner amendment): a vertical DESCENT whose target
 * region has no own remembered position follows the chain into remembered
 * NESTED positions — you can only walk down from the big fraction's
 * numerator into the nested fraction's NUMERATOR (the num→num-only path
 * the rendered geometry forces; you cannot skip the smaller numerator and
 * walk straight into the smaller denominator). The chain fires ONLY while
 * a remembered position resolves: a never-visited nest keeps the 4a
 * OA-vertical-default structural rest (the seam at the region content
 * end), unchanged.
 */
const NEST_HOP_CAP = 8;

function nestedNumStore(env: Envelope, target: Caret, mem: VerticalMemory): Caret | null {
  if (target.kind !== 'row') return null;
  const row = nodeAt(env, target.path);
  if (row === null || !isRowNode(row)) return null;
  const args = rowArgs(row);
  if (target.index !== args.length || args.length === 0) return null;
  const tail = args[args.length - 1];
  if (tail === null || tail.type !== 'frac') return null; // num→num-only
  const stored = mem.get(regionKey({ parentPath: [...target.path, args.length - 1], slot: 'num' }));
  if (stored === undefined || !caretResolvesIn(env, stored)) return null;
  return stored;
}

function chainedNestedPosition(env: Envelope, target: Caret, mem: VerticalMemory): Caret | null {
  let chain: Caret | null = null;
  let at = target;
  for (let hop = 0; hop < NEST_HOP_CAP; hop += 1) {
    const step = nestedNumStore(env, at, mem);
    if (step === null) break;
    chain = step;
    at = step;
  }
  return chain;
}

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
  // OA-vmem-nesting (4b-1) + the M-17 fix (consolidated cleanup): on a
  // DESCENT the nesting chain is consulted FIRST — a remembered nested
  // numerator position wins over the arrival region's own store (the nested
  // layer's memory is the more specific position: "the nested layer's own
  // memory doing its job"). The own store fires when no chained nested
  // position resolves; without the chain-first order a previously stored
  // parent-region position shadows the chain and the retrace never fires
  // live (the 4b-1 live check, M-17).
  if (dir === 'down') {
    const chained = chainedNestedPosition(env, target, next);
    if (chained !== null) return { caret: chained, mem: next, fired: true };
  }
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
