// Host-facing op-log serialization (op-log format v1) — a versioned,
// additive layer over the runtime LogEntry: every logged op paired with a
// compact REVERSE step, so the log alone (plus the current envelope) is
// enough to walk a session back op by op, with no state outside the log.
//
// Why reverse steps instead of reusing the forward vocabulary: the forward
// ops cannot invert two of their own placements — deleteAt rejects a null
// args cell (the null-cell splice) and the fill position, and an occupied
// replace (replaceRoot/replaceSlot/replaceCell) destroys the previous
// occupant the way back needs. So each SerializedOp carries its own rev:
//   revDelete   — remove what an insert/place put at `at` (root/slot/fill/row;
//                 splices the cell out whatever it holds, null included)
//   revInsert   — put back what a deleteAt removed (root/slot/row; `node` is
//                 the removed content)
//   revReplace  — swap back the previous occupant of a replace* placement
//   revCaret    — pure caret step (move/moveCaret); the tree is untouched
// Every rev also carries `caret` (the pre-op caret), so applying the rev
// restores the whole step — tree AND caret — not just the tree.
//
// Everything here is plain JSON data (the rev vocabulary, like the op
// vocabulary, is serializable values), and applyRevOp gates its result
// through fromJSON — the same contract boundary the reducer uses, so a rev
// can never produce a tree the contract rejects. Additive-only: the runtime
// LogEntry shape is untouched; this module only reads it.

import type { Envelope, NodeJson } from '../ast/json.js';
import { fromJSON, toJSON } from '../ast/serialize.js';
import type { StaticVocabulary } from '../ast/vocabulary.js';
import {
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
import { cloneEnvelope } from './internal.js';
import { applyOp, envelopeOf, type EditingState, type Op, type Position, type ReplacePosition } from './ops.js';

/** The reverse-step vocabulary (format v1, additive) — see the module header. */
export type RevOp =
  | {
      readonly rev: 'revDelete';
      /** Where the forward insert/place landed (any non-replace position). */
      readonly at: Extract<Position, { at: 'root' | 'slot' | 'row' | 'fill' }>;
      /** Pre-op caret: restoring it inverts the op's caret relocation. */
      readonly caret: Caret;
    }
  | {
      readonly rev: 'revInsert';
      /** Where the forward deleteAt removed (deleteAt's domain: root/slot/row). */
      readonly at: Extract<Position, { at: 'root' | 'slot' | 'row' }>;
      /** The removed content, put back verbatim. */
      readonly node: NodeJson | null;
      readonly caret: Caret;
    }
  | {
      readonly rev: 'revReplace';
      readonly at: ReplacePosition;
      /** The occupant before the replace — strict occupancy made it non-null. */
      readonly prev: NodeJson | null;
      readonly caret: Caret;
    }
  | { readonly rev: 'revCaret'; readonly caret: Caret };

/** One logged op paired with its reverse step — enough to invert exactly this
 *  one step from the post-op state alone. */
export interface SerializedOp {
  readonly op: Op;
  readonly rev: RevOp;
}

/** One undo unit in serialized form: the ops with their revs, plus the pre-unit
 *  snapshots (mirroring the runtime LogEntry). */
export interface OpLogEntry {
  readonly ops: readonly SerializedOp[];
  readonly before: Envelope;
  readonly caretBefore: Caret;
}

/** The session's op log, format-versioned from day one (`v: 1`). Additive-only:
 *  later versions may add fields and rev kinds, never rename or reshape these.
 *  `entries[0].before` is the session's pre-first-edit envelope, so a full
 *  walk-back lands on a value the log itself carries. The LIVE undo stack is
 *  serialized — an entry popped by undo leaves the log until a redo re-logs it. */
export interface OpLog {
  readonly v: 1;
  readonly entries: readonly OpLogEntry[];
}

/** The content at `at` in the PRE-op envelope: what a deleteAt removed or a
 *  replace displaced (non-null by the forward ops' strict-occupancy guards). */
function occupiedAt(env: Envelope, at: Position): NodeJson | null {
  switch (at.at) {
    case 'root':
    case 'replaceRoot':
      return env.root;
    case 'slot':
    case 'replaceSlot':
      return slotValue(requireSlotParent(env, at.path, at.slot), at.slot);
    case 'row':
    case 'replaceCell': {
      const args = rowArgs(requireRowParent(env, at.path));
      return at.index >= 0 && at.index < args.length ? args[at.index] : null;
    }
    default:
      throw new EngineError('unknown-position', `oplog: no occupied content at '${(at as { at: string }).at}'`);
  }
}

/** Derive the reverse step of one forward op from the op and its PRE-op
 *  envelope + caret (serializeOpLog computes those by replaying the unit). */
export function revOfOp(op: Op, preEnv: Envelope, preCaret: Caret): RevOp {
  switch (op.op) {
    case 'insert':
    case 'place': {
      const at = op.at;
      if (at.at === 'replaceRoot' || at.at === 'replaceSlot' || at.at === 'replaceCell') {
        return { rev: 'revReplace', at, prev: occupiedAt(preEnv, at), caret: preCaret };
      }
      return { rev: 'revDelete', at, caret: preCaret };
    }
    case 'deleteAt':
      // DeleteAtOp.at is declared as the full Position union; the runtime
      // domain is root/slot/row (deleteAtFrom rejects the rest, so a logged
      // deleteAt always sits inside it) — hence the cast.
      return {
        rev: 'revInsert',
        at: op.at as Extract<Position, { at: 'root' | 'slot' | 'row' }>,
        node: occupiedAt(preEnv, op.at),
        caret: preCaret,
      };
    case 'moveCaret':
    case 'move':
      return { rev: 'revCaret', caret: preCaret };
  }
}

/** Apply one reverse step to an envelope: returns the PRE-op envelope. The
 *  pre-op caret rides on the rev (`rev.caret`) — restoring it inverts the
 *  caret part of the step. The transform runs on a clone and the result
 *  through the fromJSON contract gate (canonicalized via toJSON), exactly
 *  like the reducer's own op application; `revCaret` touches no tree and
 *  returns the envelope as-is. */
export function applyRevOp(env: Envelope, rev: RevOp, vocabulary?: StaticVocabulary): Envelope {
  if (rev.rev === 'revCaret') return env;
  const next = cloneEnvelope(env);
  switch (rev.rev) {
    case 'revDelete': {
      // Inverse of a forward insert/place. Unlike the forward deleteAt this
      // accepts a null cell (the null-cell splice) and the fill position —
      // exactly the placements deleteAt rejects.
      const at = rev.at;
      switch (at.at) {
        case 'root':
          next.root = null;
          break;
        case 'slot':
          setSlot(requireSlotParent(next, at.path, at.slot), at.slot, null);
          break;
        case 'fill':
          rowArgs(requireRowParent(next, at.path))[at.index] = null;
          break;
        case 'row':
          rowArgs(requireRowParent(next, at.path)).splice(at.index, 1);
          break;
        default:
          throw new EngineError('unknown-op', `revDelete: '${(at as { at: string }).at}' is a replace placement — invert it with revReplace`);
      }
      break;
    }
    case 'revInsert': {
      // Inverse of a forward deleteAt: put the removed content back.
      const at = rev.at;
      switch (at.at) {
        case 'root':
          next.root = rev.node;
          break;
        case 'slot':
          setSlot(requireSlotParent(next, at.path, at.slot), at.slot, rev.node);
          break;
        case 'row':
          rowArgs(requireRowParent(next, at.path)).splice(at.index, 0, rev.node);
          break;
        default:
          throw new EngineError('unknown-op', `revInsert: '${(at as { at: string }).at}' is not a deleteAt position`);
      }
      break;
    }
    case 'revReplace': {
      const at = rev.at;
      switch (at.at) {
        case 'replaceRoot':
          next.root = rev.prev;
          break;
        case 'replaceSlot':
          setSlot(requireSlotParent(next, at.path, at.slot), at.slot, rev.prev);
          break;
        case 'replaceCell':
          rowArgs(requireRowParent(next, at.path))[at.index] = rev.prev;
          break;
      }
      break;
    }
  }
  return toJSON(fromJSON(next, vocabulary));
}

/** Serialize the session's live undo log into the versioned OpLog (v1): each
 *  unit's ops replayed op-by-op from the unit's own pre-unit snapshot — the
 *  reducer is pure and deterministic (the same walk redo() performs), so
 *  every op gets the exact pre-op envelope/caret its rev is derived from. */
export function serializeOpLog(state: EditingState): OpLog {
  const entries: OpLogEntry[] = [];
  for (const entry of state.log) {
    let cur: EditingState = {
      root: fromJSON(entry.before, state.vocabulary),
      caret: entry.caretBefore,
      log: [],
      redo: [],
      vocabulary: state.vocabulary,
    };
    const ops: SerializedOp[] = [];
    for (const op of entry.ops) {
      ops.push({ op, rev: revOfOp(op, envelopeOf(cur), cur.caret) });
      cur = applyOp(cur, op); // advances root/caret; the scratch log is discarded
    }
    entries.push({ ops, before: entry.before, caretBefore: entry.caretBefore });
  }
  return { v: 1, entries };
}

function requireSlotParent(env: Envelope, path: Path, slot: SlotName): NodeJson {
  const parent = nodeAt(env, path);
  if (parent === null || !hasSlot(parent, slot)) {
    throw new EngineError('unknown-position', `oplog: no node with slot '${slot}' at path [${path.join(',')}]`);
  }
  return parent;
}

function requireRowParent(env: Envelope, path: Path): NodeJson {
  const parent = nodeAt(env, path);
  if (parent === null || !isRowNode(parent)) {
    throw new EngineError('unknown-position', `oplog: no args row at path [${path.join(',')}]`);
  }
  return parent;
}
