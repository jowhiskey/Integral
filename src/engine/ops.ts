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
  nodeAt,
  rowArgs,
  setSlot,
  slotValue,
  type Caret,
  type Path,
  type SlotName,
} from './caret.js';
import { EngineError } from './errors.js';

/** Where an op acts — always an explicit path, never a policy decision. */
export type Position =
  | { readonly at: 'root' }
  | { readonly at: 'slot'; readonly path: Path; readonly slot: SlotName }
  | { readonly at: 'row'; readonly path: Path; readonly index: number };

/** Place the given node at a position: fill the empty root slot, fill an
 *  empty fixed slot, or splice into an args row at an index. */
export interface InsertOp {
  readonly op: 'insert';
  readonly node: NodeJson;
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

/** The session-1 op vocabulary — plain data values (serializable, so op logs
 *  can be persisted, replayed, and property-tested without a DOM). */
export type Op = InsertOp | DeleteAtOp | MoveCaretOp;

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
  readonly vocabulary?: StaticVocabulary;
}

const EMPTY_ENVELOPE: Envelope = { v: 1, root: null };

/**
 * Open an editing session. `envelope` is validated through fromJSON (typed
 * ValidationError on invalid trees); omitted = the empty formula. The initial
 * caret is the defined per-state default: `empty` for an empty formula, the
 * root node otherwise.
 */
export function initSession(envelope?: unknown, vocabulary?: StaticVocabulary): EditingState {
  const root = fromJSON(envelope ?? EMPTY_ENVELOPE, vocabulary);
  const caret: Caret = root === null ? { kind: 'empty' } : { kind: 'node', path: [] };
  return { root, caret, log: [], vocabulary };
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
    default:
      throw new EngineError('unknown-op', `applyOp: unknown op ${JSON.stringify((op as { op: unknown }).op)}`);
  }
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
    vocabulary: state.vocabulary,
  };
}

/** Fresh copy of an envelope the reducer owns and may mutate. JSON clone —
 *  structuredClone's type declaration lives in DOM libs, which this subpath
 *  must not pull in. Envelopes are JSON by definition, so nothing survives a
 *  JSON clone that shouldn't. */
const cloneEnvelope = (env: Envelope): Envelope => JSON.parse(JSON.stringify(env)) as Envelope;

/** One tree-mutating op: serialize + clone, transform the clone at the JSON
 *  level, rebuild through fromJSON (the contract gate), relocate the caret
 *  by the op's defined rule. */
function applyMutating<T extends InsertOp | DeleteAtOp>(
  state: EditingState,
  op: T,
  transform: (env: Envelope, op: T) => void,
): EditingState {
  const before = toJSON(state.root);
  const env = cloneEnvelope(before);
  transform(env, op);
  const root = fromJSON(env, state.vocabulary);
  const caret = relocateCaret(state.caret, op, env);
  if (!caretResolvesIn(env, caret)) {
    // unreachable: the relocation rules cover every removal/shift case
    throw new Error('engine invariant: caret normalization failed');
  }
  return { root, caret, log: [...state.log, { op, before, caretBefore: state.caret }], vocabulary: state.vocabulary };
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
    vocabulary: state.vocabulary,
  };
}

// ——— Op transforms (JSON level; the envelope is the reducer's working copy) ———

function insertInto(env: Envelope, op: InsertOp): void {
  const at = op.at;
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
  }
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

/**
 * After an op the caret is always in a defined state. Rules:
 * - insert at root          → the new node (root path).
 * - insert filling a slot   → a caret that was IN that slot moves onto the
 *                             inserted node; every other caret survives where
 *                             it still resolves.
 * - row splice              → coordinates in the spliced row's address space
 *                             shift with the splice (adjustRowCaret); nothing
 *                             else moves.
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
function relocateCaret(caretBefore: Caret, op: InsertOp | DeleteAtOp, env: Envelope): Caret {
  const at = op.at;
  switch (at.at) {
    case 'root':
      return op.op === 'insert' ? { kind: 'node', path: [] } : { kind: 'empty' };
    case 'slot': {
      if (op.op === 'insert') {
        const wasThere =
          caretBefore.kind === 'slot' && samePath(caretBefore.path, at.path) && caretBefore.slot === at.slot;
        return wasThere ? { kind: 'node', path: [...at.path, at.slot] } : caretBefore;
      }
      return enteredThrough(caretBefore, at.path, at.slot)
        ? { kind: 'slot', path: at.path, slot: at.slot }
        : caretBefore;
    }
    case 'row':
      return adjustRowCaret(caretBefore, at.path, at.index, op.op === 'insert' ? 1 : -1);
  }
}
