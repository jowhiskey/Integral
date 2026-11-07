// Vertical positional memory (editor-layer state, pure, never logged) — the
// keyboard-layer replacement for pixel x-conservation. At most one entry per
// AST node: entry[node the caret resolves in] = { originCaret, pressed
// direction }. Recorded when a vertical key press structurally LEAVES a node
// (overwritten on each leaving); it FIRES when a vertical key press would
// structurally ENTER a node holding an opposite-direction entry — the caret
// jumps to the recorded origin instead of applying the structural move
// (jump-back wins). Entries persist after firing (idempotent retrace) until
// overwritten or cleared. ArrowLeft/Right delete only the entry of the node
// the caret is currently in; typed ops, undo, redo and click placement clear
// the whole map (the controller does that — this module stays pure).
//
// The map is keyed by AST nodes of the session's current envelope — never DOM
// elements — so it is immune to full rebuilds by construction; tree-changing
// actions clear it wholesale anyway, so keys can never go stale across trees.

import type { Envelope, NodeJson } from '../ast/json.js';

import { caretResolvesIn, nodeAt, resolveMove, type Caret, type NavDir } from '../engine/index.js';

export interface VerticalMemoryEntry {
  readonly originCaret: Caret;
  readonly direction: NavDir;
}

/** The memory map (owned by the controller; the helpers here are pure and
 *  return fresh maps). */
export type VerticalMemory = Map<NodeJson, VerticalMemoryEntry>;

/** The node a caret resolves in: a row caret — and a node caret sitting on a
 *  row cell — resolves in the row; a slot caret resolves in its owner; any
 *  other node caret resolves in the node itself. Null for the empty-formula
 *  caret. */
export function memoryNode(env: Envelope, caret: Caret): NodeJson | null {
  if (caret.kind === 'empty') return null;
  const p = caret.path;
  if (caret.kind === 'node' && p.length > 0 && typeof p[p.length - 1] === 'number') {
    return nodeAt(env, p.slice(0, -1));
  }
  return nodeAt(env, p);
}

const sameCaret = (a: Caret, b: Caret): boolean => JSON.stringify(a) === JSON.stringify(b);

const isOpposite = (a: NavDir, b: NavDir): boolean => (a === 'up' && b === 'down') || (a === 'down' && b === 'up');

export interface VerticalKeyResult {
  readonly caret: Caret;
  readonly mem: VerticalMemory;
  readonly fired: boolean;
}

/** One vertical key press, resolved purely (nothing applied, nothing logged):
 *  the structural move target is computed first; if the target's node holds
 *  an opposite-direction entry whose origin caret still resolves, the
 *  jump-back wins (`fired`: the origin caret is returned, the entry persists,
 *  nothing is recorded). A dangling entry (origin no longer resolves) is
 *  discarded and the structural move is used. Otherwise the structural target
 *  is returned and the before-node's entry is set/overwritten with
 *  { originCaret: the caret before the move, pressed direction }. A press with
 *  no move target changes nothing. */
export function applyVerticalKey(env: Envelope, caret: Caret, dir: NavDir, mem: VerticalMemory): VerticalKeyResult {
  const target = resolveMove(env, caret, dir);
  if (target === null || sameCaret(target, caret)) return { caret, mem, fired: false };
  const next: VerticalMemory = new Map(mem);
  const tKey = memoryNode(env, target);
  if (tKey !== null) {
    const entry = next.get(tKey);
    if (entry !== undefined && isOpposite(dir, entry.direction)) {
      if (caretResolvesIn(env, entry.originCaret)) {
        return { caret: entry.originCaret, mem: next, fired: true };
      }
      next.delete(tKey); // dangling entry: discard, use the structural move
    }
  }
  const bKey = memoryNode(env, caret);
  if (bKey !== null) next.set(bKey, { originCaret: caret, direction: dir });
  return { caret: target, mem: next, fired: false };
}

/** A horizontal key press deletes ONLY the entry for the node the caret is
 *  currently in (pure: returns a fresh map; all other entries survive). */
export function clearCurrentNode(env: Envelope, caret: Caret, mem: VerticalMemory): VerticalMemory {
  const next: VerticalMemory = new Map(mem);
  const key = memoryNode(env, caret);
  if (key !== null) next.delete(key);
  return next;
}
