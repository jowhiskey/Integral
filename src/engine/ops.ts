// Ops as values, applied by a pure reducer. The session-1 op set is mechanical:
// Insert places a given node at an explicit position, DeleteAt removes one,
// MoveCaret sets the caret. Placement semantics are explicit-path only —
// deciding structure from typed input is the insertion policy (a later
// session); the ops here are the transforms that policy will emit.
//
// Purity mechanics: every op serializes the current tree (`toJSON` — a fresh
// allocation each call), clones that envelope, transforms the clone, and
// rebuilds through `fromJSON`. The clone is the working copy; the original
// serialization is the undo snapshot. The previous state is never touched
// (node fields are readonly), and the op log is shared structurally between
// states. Running every result through fromJSON reuses the AST contract
// boundary itself as the validation gate — an op can never produce a tree
// the contract rejects, with zero duplicated invariant logic.

import type { Envelope, NodeJson } from '../ast/json.js';
import type { MathNode } from '../ast/nodes.js';
import { fromJSON, toJSON } from '../ast/serialize.js';
import type { StaticVocabulary } from '../ast/vocabulary.js';
import {
  adjustRowCaret,
  caretResolvesIn,
  entryPath,
  hasSlot,
  isRowNode,
  isTokenNode,
  nodeAt,
  rowArgs,
  setSlot,
  slotValue,
  slotsOf,
  tokenText,
  type Caret,
  type Path,
  type SlotName,
} from './caret.js';
import { EngineError } from './errors.js';
import { NAV_PROFILES, entryStation, rowEndStation, resolveMove, type NavDir } from './nav.js';

/** Where an op acts — always an explicit path, never a policy decision.
 *
 *  `fill` targets a NULL args cell (the operand-expected position a typed
 *  operator leaves behind — filling replaces the null in place, one op);
 *  `replaceRoot` / `replaceSlot` / `replaceCell` target an OCCUPIED root /
 *  fixed slot / args cell and swap its content for the op's node subtree
 *  (one op = one log entry; the wrapper carries its own null cells inside,
 *  fromJSON stays the validation gate; strict occupancy is what catches
 *  policy bugs — an empty target is an error, never a lenient fill). */
export type Position =
  | { readonly at: 'root' }
  | { readonly at: 'slot'; readonly path: Path; readonly slot: SlotName }
  | { readonly at: 'row'; readonly path: Path; readonly index: number }
  | { readonly at: 'fill'; readonly path: Path; readonly index: number }
  | { readonly at: 'replaceRoot' }
  | { readonly at: 'replaceSlot'; readonly path: Path; readonly slot: SlotName }
  | { readonly at: 'replaceCell'; readonly path: Path; readonly index: number };

/** The occupied-replace placements (typing relocations swap a whole subrow
 *  subtree at one of these, reusing the replace mechanics). */
export type ReplacePosition =
  | { readonly at: 'replaceRoot' }
  | { readonly at: 'replaceSlot'; readonly path: Path; readonly slot: SlotName }
  | { readonly at: 'replaceCell'; readonly path: Path; readonly index: number };

/** Insert data: the node to place. `node` is null ONLY for the `row` position
 *  — the null-cell splice (rework session 2a): a typed glyph extends its
 *  same-op row by growing a separator slot there, the null cell being the
 *  glyph's pending operand (leading/interior/trailing all legal, rendered
 *  bare per the session-1 T7 split). Every other position requires a node. */
export interface InsertOp {
  readonly op: 'insert';
  readonly node: NodeJson | null;
  readonly at: Position;
}

/** Remove a node: clear the root, clear a slot to null, or splice an arg out
 *  of an args row. */
export interface DeleteAtOp {
  readonly op: 'deleteAt';
  readonly at: Position;
}

/** Set the caret to an explicit target (validated against the tree). */
export interface MoveCaretOp {
  readonly op: 'moveCaret';
  readonly to: Caret;
}

/** Relative caret movement in a direction, resolved through the nav-profile
 *  registry. No target (document edge, empty formula, direction into
 *  nothing) is a defined no-op: the state is returned unchanged. Pure caret
 *  movement never enters the undo log. */
export interface MoveOp {
  readonly op: 'move';
  readonly dir: NavDir;
}

/**
 * Place a node at a position with an EXPLICIT result caret (rework session
 * 2a; the mechanical successor of the swap op). The transform is the insert/
 * insert-position semantics (root/slot/row/fill/replace*, occupancy errors
 * included); the relocation is the op's own `to` — validated like every
 * caret. The typing policy computes both the node and where the caret lands
 * ("directly after the inserted token"), so one typed token = one op = one
 * log entry with exact placement.
 */
export interface PlaceOp {
  readonly op: 'place';
  /** Null is legal only for the `row` position (the null-cell splice with
   *  an explicit result caret — the guard in insertInto enforces it). */
  readonly node: NodeJson | null;
  readonly at: Position;
  /** Caret after the op; validated against the transformed tree. */
  readonly to: Caret;
}

/** The op vocabulary — plain data values (serializable, so op logs can be
 *  persisted, replayed, and property-tested without a DOM). */
export type Op = InsertOp | DeleteAtOp | MoveCaretOp | MoveOp | PlaceOp;

/** One applied op. Undo snapshots the full tree + caret state before the op —
 *  mechanics chosen over inverse ops: byte-exact restoration by construction
 *  and no inverse-derivation asymmetries; entries are plain data (hosts may
 *  merge them later, per the spec's op-log note). */
export interface LogEntry {
  readonly op: Op;
  /** Envelope snapshot taken before the op applied. */
  readonly before: Envelope;
  /** Caret state before the op applied. */
  readonly caretBefore: Caret;
}

/** Editing-session state: pure in-memory (tree + caret + op log); local to the
 *  session until the host persists on blur. The vocabulary (if any) is the one
 *  the session was opened with and gates every fromJSON the engine performs —
 *  including op results, so inserted subtrees validate against the same unit
 *  list the session started with. */
export interface EditingState {
  readonly root: MathNode | null;
  readonly caret: Caret;
  readonly log: readonly LogEntry[];
  /** Redo list (additive): entries popped off the log by undo. Any NEW
   *  tree-changing op clears it (applyMutating); pure movement and undo/redo
   *  themselves keep it. Empty = redo is a defined no-op. */
  readonly redo: readonly LogEntry[];
  readonly vocabulary?: StaticVocabulary;
}

const EMPTY_ENVELOPE: Envelope = { v: 1, root: null };

/**
 * Open an editing session. `envelope` is validated through fromJSON (typed
 * ValidationError on invalid trees); omitted = the empty formula. The initial
 * caret is the just-typed analog (rework 4a — the old root node-caret is
 * unreachable-ized per OA-visual-trumps; its documented readings normalize
 * onto the states that actually paint there):
 * - an INCOMPLETE tree pends in its first empty station — the □ slot or the
 *   pending null cell (the natural continue);
 * - a lone text token / sub / unit rests at its in-token END (the node
 *   caret's "right edge" reading);
 * - a complete op row rests at its collapsed row end;
 * - a complete fenced/fenceless container (group/fn/frac/pow/root) rests at
 *   its whole-structure after-station (the additive node `side: 'right'`).
 */
export function initSession(envelope?: unknown, vocabulary?: StaticVocabulary): EditingState {
  const root = fromJSON(envelope ?? EMPTY_ENVELOPE, vocabulary);
  if (root === null) return { root, caret: { kind: 'empty' }, log: [], redo: [], vocabulary };
  const env = toJSON(root);
  const pend = firstEmpty(env.root as NodeJson);
  if (pend !== null) {
    return {
      root,
      caret: 'slot' in pend ? { kind: 'slot', path: [], slot: pend.slot } : { kind: 'row', path: [], index: pend.index },
      log: [],
      redo: [],
      vocabulary,
    };
  }
  const t = (env.root as NodeJson).type;
  const caret: Caret =
    t === 'group' || t === 'fn' || t === 'frac' || t === 'pow' || t === 'root'
      ? { kind: 'node', path: [], side: 'right' }
      : t === 'op'
        ? (rowEndStation(env, [], 'right', NAV_PROFILES) ?? { kind: 'node', path: [] })
        : (entryStation(env, [], 'right', NAV_PROFILES) ?? { kind: 'node', path: [] });
  return { root, caret, log: [], redo: [], vocabulary };
}

/** The session's current tree envelope (what the host persists). */
export function envelopeOf(state: EditingState): Envelope {
  return toJSON(state.root);
}

/** True iff the caret resolves to a real position in this tree (or the defined
 *  empty-formula state). Exported for hosts and later sessions (navigation,
 *  insertion policy) — the engine itself guarantees it after every op. */
export function caretResolves(root: MathNode | null, caret: Caret): boolean {
  return caretResolvesIn(toJSON(root), caret);
}

// ——— Reducer ———

/** Pure reducer: apply one op. Never mutates the given state; on error the
 *  state is unchanged and nothing is logged. Position/address mistakes throw
 *  EngineError; contract violations (invalid inserted node, arity/budget
 *  overruns) propagate fromJSON's ValidationError / ValidationLimitError. */
export function applyOp(state: EditingState, op: Op): EditingState {
  switch (op.op) {
    case 'insert':
      return applyMutating(state, op, insertInto);
    case 'deleteAt':
      return applyMutating(state, op, deleteAtFrom);
    case 'moveCaret':
      return applyMoveCaret(state, op);
    case 'move':
      return applyMove(state, op);
    case 'place':
      // Insert-position transform with the op's own explicit result caret.
      return applyMutating(state, op, placeInto);
    default:
      throw new EngineError('unknown-op', `applyOp: unknown op ${JSON.stringify((op as { op: unknown }).op)}`);
  }
}

const NAV_DIRS: readonly NavDir[] = ['left', 'right', 'up', 'down'];

function sameCaret(a: Caret, b: Caret): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Relative movement: resolved against the nav profiles; the tree is never
 *  touched, the log is never appended. Unresolvable/uninteresting targets
 *  are no-ops — the exact state object comes back. */
function applyMove(state: EditingState, op: MoveOp): EditingState {
  if (!NAV_DIRS.includes(op.dir)) {
    throw new EngineError('unknown-op', `move: unknown direction ${JSON.stringify(op.dir)}`);
  }
  if (state.caret.kind === 'empty') return state;
  const env = toJSON(state.root);
  const target = resolveMove(env, state.caret, op.dir);
  if (target === null || sameCaret(target, state.caret)) return state;
  if (!caretResolvesIn(env, target)) {
    // unreachable: the resolver only addresses real positions
    throw new Error('engine invariant: movement produced an unresolvable caret');
  }
  return { root: state.root, caret: target, log: state.log, redo: state.redo, vocabulary: state.vocabulary };
}

/** Walk back exactly one op: restore the tree and caret snapshotted before it.
 *  Undo on an empty log is a defined no-op — returns the state as-is. */
export function undo(state: EditingState): EditingState {
  if (state.log.length === 0) return state;
  const entry = state.log[state.log.length - 1];
  return {
    root: fromJSON(entry.before, state.vocabulary),
    caret: entry.caretBefore,
    log: state.log.slice(0, -1),
    redo: [...state.redo, entry],
    vocabulary: state.vocabulary,
  };
}

/** Fresh copy of an envelope the reducer owns and may mutate. JSON clone —
 *  structuredClone's type declaration lives in DOM libs, which this subpath
 *  must not pull in. Envelopes are JSON by definition, so nothing survives a
 *  JSON clone that shouldn't. */
/** Step the redo list forward one entry: re-apply the undone op onto its own
 *  before-snapshot. The reducer is pure and deterministic, so re-applying
 *  reproduces the post-op state byte-exactly (tree, caret, and the re-logged
 *  entry) with zero inverse-op derivation. Redo on an empty list is a defined
 *  no-op — returns the state as-is. The remaining redo entries survive (only
 *  a NEW op clears the list, in applyMutating). */

export function redo(state: EditingState): EditingState {
  if (state.redo.length === 0) return state;
  const entry = state.redo[state.redo.length - 1];
  const redoRest = state.redo.slice(0, -1);
  const base: EditingState = {
    root: fromJSON(entry.before, state.vocabulary),
    caret: entry.caretBefore,
    log: state.log,
    redo: redoRest,
    vocabulary: state.vocabulary,
  };
  const applied = applyOp(base, entry.op);
  return { ...applied, redo: redoRest };
}

const cloneEnvelope = (env: Envelope): Envelope => JSON.parse(JSON.stringify(env)) as Envelope;

/** One tree-mutating op: serialize + clone, transform the clone at the JSON
 *  level, rebuild through fromJSON (the contract gate), relocate the caret
 *  by the op's defined rule. */
function applyMutating<T extends InsertOp | DeleteAtOp | PlaceOp>(
  state: EditingState,
  op: T,
  transform: (env: Envelope, op: T) => void,
): EditingState {
  const before = toJSON(state.root);
  const env = cloneEnvelope(before);
  transform(env, op);
  const root = fromJSON(env, state.vocabulary);
  const caret = relocateCaret(state.caret, op, env, before);
  if (!caretResolvesIn(env, caret)) {
    // unreachable: the relocation rules cover every removal/shift case
    throw new Error('engine invariant: caret normalization failed');
  }
  // A new tree-changing op clears the redo list.
  return { root, caret, log: [...state.log, { op, before, caretBefore: state.caret }], redo: [], vocabulary: state.vocabulary };
}

function applyMoveCaret(state: EditingState, op: MoveCaretOp): EditingState {
  const before = toJSON(state.root);
  if (!caretResolvesIn(before, op.to)) {
    throw new EngineError('caret-invalid', `moveCaret: caret does not resolve in this tree (${JSON.stringify(op.to)})`);
  }
  return {
    root: state.root,
    caret: op.to,
    log: [...state.log, { op, before, caretBefore: state.caret }],
    redo: state.redo,
    vocabulary: state.vocabulary,
  };
}

// ——— Op transforms (JSON level; the envelope is the reducer's working copy) ———

function insertInto(env: Envelope, op: InsertOp): void {
  const at = op.at;
  if (op.node === null && at.at !== 'row') {
    throw new EngineError('unknown-op', `insert: a null cell splice is row-position-only (got '${at.at}')`);
  }
  switch (at.at) {
    case 'root': {
      if (env.root !== null) {
        throw new EngineError('slot-occupied', 'insert at root: the formula is not empty');
      }
      env.root = op.node;
      break;
    }
    case 'slot': {
      const parent = requireSlotParent(env, at.path, at.slot);
      if (slotValue(parent, at.slot) !== null) {
        throw new EngineError('slot-occupied', `insert: slot '${at.slot}' at [${at.path.join(',')}] is not empty`);
      }
      setSlot(parent, at.slot, op.node);
      break;
    }
    case 'row': {
      const parent = requireRowParent(env, at.path);
      const args = rowArgs(parent);
      if (at.index < 0 || at.index > args.length) {
        throw new EngineError('index-out-of-range', `insert: row index ${at.index} out of range [0, ${args.length}]`);
      }
      args.splice(at.index, 0, op.node);
      break;
    }
    case 'fill': {
      const parent = requireRowParent(env, at.path);
      const args = rowArgs(parent);
      if (at.index < 0 || at.index >= args.length) {
        throw new EngineError('index-out-of-range', `fill: cell index ${at.index} out of range [0, ${args.length})`);
      }
      if (args[at.index] !== null) {
        throw new EngineError('slot-occupied', `fill: args[${at.index}] is a node, not an empty cell`);
      }
      args[at.index] = op.node;
      break;
    }
    case 'replaceRoot': {
      if (env.root === null) {
        throw new EngineError('slot-empty', 'replace at root: the formula is empty');
      }
      env.root = op.node;
      break;
    }
    case 'replaceSlot': {
      const parent = requireSlotParent(env, at.path, at.slot);
      if (slotValue(parent, at.slot) === null) {
        throw new EngineError('slot-empty', `replace: slot '${at.slot}' at [${at.path.join(',')}] is empty`);
      }
      setSlot(parent, at.slot, op.node);
      break;
    }
    case 'replaceCell': {
      const parent = requireRowParent(env, at.path);
      const args = rowArgs(parent);
      if (at.index < 0 || at.index >= args.length) {
        throw new EngineError('index-out-of-range', `replace: cell index ${at.index} out of range [0, ${args.length})`);
      }
      if (args[at.index] === null) {
        throw new EngineError('slot-empty', `replace: args[${at.index}] is an empty cell, not a node`);
      }
      args[at.index] = op.node;
      break;
    }
  }
}

function deleteAtFrom(env: Envelope, op: DeleteAtOp): void {
  const at = op.at;
  switch (at.at) {
    case 'root': {
      if (env.root === null) {
        throw new EngineError('slot-empty', 'deleteAt at root: the formula is already empty');
      }
      env.root = null;
      break;
    }
    case 'slot': {
      const parent = requireSlotParent(env, at.path, at.slot);
      if (slotValue(parent, at.slot) === null) {
        throw new EngineError('slot-empty', `deleteAt: slot '${at.slot}' at [${at.path.join(',')}] is already empty`);
      }
      setSlot(parent, at.slot, null);
      break;
    }
    case 'row': {
      const parent = requireRowParent(env, at.path);
      const args = rowArgs(parent);
      if (at.index < 0 || at.index >= args.length) {
        throw new EngineError('index-out-of-range', `deleteAt: row index ${at.index} out of range [0, ${args.length})`);
      }
      if (args[at.index] === null) {
        throw new EngineError('slot-empty', `deleteAt: args[${at.index}] is an empty slot, not a node`);
      }
      args.splice(at.index, 1);
      break;
    }
    default:
      // 'fill' / 'replace*' are insert-only placements (arc session 3);
      // untouched deleteAt semantics are pinned by the session-1 suite.
      throw new EngineError(
        'unknown-op',
        `deleteAt: position '${(at as { at: string }).at}' is insert-only`,
      );
  }
}

/** The place transform: the insert-position mechanics (incl. occupancy
 *  errors) — the typing policy hands the reducer a finished node. A null
 *  node is legal only for the row position (the null-cell splice with an
 *  explicit result caret). */
function placeInto(env: Envelope, op: PlaceOp): void {
  insertInto(env, { op: 'insert', node: op.node, at: op.at });
}

function requireSlotParent(env: Envelope, path: Path, slot: SlotName): NodeJson {
  const parent = nodeAt(env, path);
  if (parent === null || !hasSlot(parent, slot)) {
    throw new EngineError('unknown-position', `no node with slot '${slot}' at path [${path.join(',')}]`);
  }
  return parent;
}

function requireRowParent(env: Envelope, path: Path): NodeJson {
  const parent = nodeAt(env, path);
  if (parent === null || !isRowNode(parent)) {
    throw new EngineError('unknown-position', `no args row at path [${path.join(',')}]`);
  }
  return parent;
}

// ——— Caret relocation (defined per op) ———

const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((step, i) => step === b[i]);

/** True iff the caret's address enters the removed subtree through
 *  (…path, slot) — i.e. whatever it pointed at lived inside that subtree. */
function enteredThrough(caret: Caret, path: Path, slot: SlotName): boolean {
  const entry = entryPath(caret);
  return (
    entry.length >= path.length + 1 &&
    entry.slice(0, path.length).every((step, i) => step === path[i]) &&
    entry[path.length] === slot
  );
}

/** The enteredThrough analog for an args cell: the caret's address passes
 *  strictly deeper than the row, entering through this index. A row caret
 *  ON the row itself does not enter any cell — seam indices are not owned
 *  by the cells they precede, so they survive replaces untouched. */
function enteredThroughCell(caret: Caret, path: Path, index: number): boolean {
  const entry = entryPath(caret);
  return (
    entry.length > path.length &&
    entry.slice(0, path.length).every((step, i) => step === path[i]) &&
    entry[path.length] === index
  );
}

/** The first empty child of a node, shallow: args cells in reading order
 *  first, then fixed slots in flow order (nav-profile flow, declaration
 *  order where a type declares none). The natural-continue position — the
 *  operand a freshly attached structure is waiting for. */
export function firstEmpty(node: NodeJson): { index: number } | { slot: SlotName } | null {
  if (isRowNode(node)) {
    const args = rowArgs(node);
    const index = args.findIndex((cell) => cell === null);
    return index === -1 ? null : { index };
  }
  const flow = NAV_PROFILES[node.type]?.flow ?? slotsOf(node);
  for (const slot of flow) {
    if (slotValue(node, slot) === null) return { slot };
  }
  return null;
}

/** Replace's relocation: the caret dives to the inserted subtree's first
 *  empty child (natural continue); a subtree with no empty cell lands the
 *  caret on the inserted node itself. */
function diveCaret(inserted: NodeJson, path: Path): Caret {
  const empty = firstEmpty(inserted);
  if (empty === null) return { kind: 'node', path };
  return 'slot' in empty
    ? { kind: 'slot', path, slot: empty.slot }
    : { kind: 'row', path, index: empty.index };
}

/** A token caret sitting exactly on a replaced num/sym keeps its in-token
 *  offset, clamped to the new length — a shrink (backspace peel) keeps the
 *  offset, a grow (digit merge / letter glue) advances the caret one position
 *  past the inserted text. Returns null when the rule does not apply (the
 *  replace relocates by the dive rule instead). */
function preservedTokenCaret(
  caretBefore: Caret,
  replacedPath: Path,
  op: InsertOp,
  before: Envelope,
): Caret | null {
  if (caretBefore.kind !== 'token' || !samePath(caretBefore.path, replacedPath)) return null;
  if (op.node !== null && !isTokenNode(op.node)) return null;
  const beforeNode = nodeAt(before, caretBefore.path);
  if (beforeNode === null || !isTokenNode(beforeNode)) return null;
  const newLen = op.node === null ? 0 : tokenText(op.node).length;
  const index =
    newLen > tokenText(beforeNode).length
      ? Math.min(caretBefore.index + 1, newLen)
      : Math.min(caretBefore.index, newLen);
  return { kind: 'token', path: replacedPath, index };
}

/**
 * After an op the caret is always in a defined state. Rules:
 * - insert at root          → the new node (root path).
 * - insert filling a slot   → a caret that was IN that slot, or sitting ON
 *                             the slot's owner, moves onto the inserted node
 *                             (the natural-continue hop that pairs with the
 *                             typewriter's dive: typing at a node with a
 *                             pending slot continues inside it); every other
 *                             caret survives where it still resolves.
 * - row splice              → coordinates in the spliced row's address space
 *                             shift with the splice (adjustRowCaret); nothing
 *                             else moves.
 * - null-cell splice        → the row-plug shift above; the caret plays
 *                             through adjustRowCaret like any splice (a
 *                             typed glyph's seam sits directly after it).
 * - fill (null args cell)   → the caret that was in the filled cell, or on
 *                             the row's owner, moves onto the new node
 *                             (owner hop mirrors the slot rule); every
 *                             other caret survives.
 * - replace (occupied root/slot/cell) → a caret whose address enters the
 *                             replaced content dives to the inserted
 *                             subtree's first empty child (natural continue),
 *                             or onto the inserted node when it has none.
 *                             Carets outside the replaced content survive
 *                             unchanged — a replace never shifts coordinates.
 * - place (rework 2a)       → the op's own explicit `to` (validated); the
 *                             typing policy computes it ("directly after
 *                             the inserted token").
 * - deleteAt at root        → the empty-formula caret.
 * - deleteAt clearing a slot → the now-empty slot; only a caret whose address
 *                             was inside the removed subtree falls back to it,
 *                             everything else survives.
 * - deleteAt splicing a row → the seam (row insertion point at the removal
 *                             position) for everything that lived inside the
 *                             removed arg; everything else shifts or survives.
 *
 * The final validity check happens in applyMutating — a relocation rule that
 * produced an unresolvable caret is an engine bug, not an accepted state.
 */
function relocateCaret(
  caretBefore: Caret,
  op: InsertOp | DeleteAtOp | PlaceOp,
  env: Envelope,
  before: Envelope,
): Caret {
  if (op.op === 'place') {
    // The place op's own relocation: the caret the typing policy derived.
    // Validated like every relocation below.
    return op.to;
  }
  const at = op.at;
  switch (at.at) {
    case 'root':
      return op.op === 'insert' ? { kind: 'node', path: [] } : { kind: 'empty' };
    case 'slot': {
      if (op.op === 'insert') {
        const wasThere =
          (caretBefore.kind === 'slot' && samePath(caretBefore.path, at.path) && caretBefore.slot === at.slot) ||
          (caretBefore.kind === 'node' && samePath(caretBefore.path, at.path));
        return wasThere ? { kind: 'node', path: [...at.path, at.slot] } : caretBefore;
      }
      return enteredThrough(caretBefore, at.path, at.slot)
        ? { kind: 'slot', path: at.path, slot: at.slot }
        : caretBefore;
    }
    case 'row':
      return adjustRowCaret(caretBefore, at.path, at.index, op.op === 'insert' ? 1 : -1);
    case 'fill':
      if (op.op !== 'insert') {
        throw new EngineError('unknown-op', `deleteAt: position '${at.at}' is insert-only`);
      }
      return (
        (caretBefore.kind === 'row' &&
          samePath(caretBefore.path, at.path) &&
          caretBefore.index === at.index) ||
          (caretBefore.kind === 'node' && samePath(caretBefore.path, at.path))
      ) ? { kind: 'node', path: [...at.path, at.index] } : caretBefore;
    case 'replaceRoot': {
      if (op.op !== 'insert') {
        throw new EngineError('unknown-op', `deleteAt: position '${at.at}' is insert-only`);
      }
      return preservedTokenCaret(caretBefore, [], op, before) ?? diveCaret(op.node!, []);
    }
    case 'replaceSlot':
      if (op.op !== 'insert') {
        throw new EngineError('unknown-op', `deleteAt: position '${at.at}' is insert-only`);
      }
      return (
        preservedTokenCaret(caretBefore, [...at.path, at.slot], op, before) ??
        (enteredThrough(caretBefore, at.path, at.slot)
          ? diveCaret(op.node!, [...at.path, at.slot])
          : caretBefore)
      );
    case 'replaceCell':
      if (op.op !== 'insert') {
        throw new EngineError('unknown-op', `deleteAt: position '${at.at}' is insert-only`);
      }
      return (
        preservedTokenCaret(caretBefore, [...at.path, at.index], op, before) ??
        (enteredThroughCell(caretBefore, at.path, at.index)
          ? diveCaret(op.node!, [...at.path, at.index])
          : caretBefore)
      );
  }
}
