// Backspace (DOM-arc session 3): decideBackspace — a pure decision function
// styled after decideAttach/decideSwap — that emits EXISTING mechanical ops.
// One backspace = at most one op = at most one log entry; a no-op decision
// applies nothing and logs nothing.
//
// Ruled semantics:
// 1. Atomic deletion: backspace deletes the node left of the caret. A number
//    target loses its last digit before the caret (character-wise; an
//    in-token caret keeps its offset, clamped); an emptied number is removed
//    with the caret in the freed spot. Every other node kind (identifier,
//    unit, function name, structure) goes whole, at any nesting level.
// 2. The last-content guard (unconditional): deleteAt never deletes the
//    parent — the freed region becomes the empty-slot placeholder and the
//    caret lands in it, even when every other region of the parent is already
//    a placeholder (a fraction with two placeholders stays on screen).
// 3. Structure death — the only path that deletes a parent: a backspace AT a
//    placeholder region (a slot caret, or a row caret in a null cell) deletes
//    the whole parent iff every region of the parent is an empty placeholder;
//    while any region still has content it is a no-op. Caret in the freed spot
//    at the parent's former position. Uniform across fractions, groups,
//    function/op rows, powers, roots, units.
// 4. Ctrl+Backspace = whole-node delete under the same guard: the whole
//    number when the caret is in-token; otherwise the same target plain
//    backspace would take.
// 5. No-op cases: the empty formula, the start of a region (row seam 0, an
//    in-token offset 0), an empty cell left of a seam caret — defined no-ops,
//    never structure-destroying.
//
// Targets by caret kind: `node` — the node the caret is on; `row` seam i>0 —
// cell i-1 (a null cell there = no node = no-op); `slot` / in-cell `row` —
// rule 3; `token` offset i>0 — the digit at i-1, offset 0 = no-op.

import type { Envelope, NodeJson } from '../ast/json.js';

import {
  caretResolvesIn,
  nodeAt,
  refOfPath,
  rowArgs,
  slotsOf,
  slotValue,
  tokenText,
  type Caret,
  type Ref,
} from './caret.js';

import { EngineError } from './errors.js';

import { applyOp, envelopeOf, type EditingState, type Op, type Position } from './ops.js';

export type BackspaceKind = 'noop' | 'shorten' | 'delete' | 'structure-death';

export interface BackspaceDecision {
  readonly kind: BackspaceKind;
  /** Zero ops: a defined no-op. Otherwise exactly one mechanical op. */
  readonly ops: readonly Op[];
  /** The caret after the op applies (the mechanical relocation outcome). */
  readonly caret: Caret;
}

/** The freed spot a deleteAt leaves at `ref`: root → the empty-formula caret,
 *  slot → the slot caret, cell → the row seam at the removal position. */
function freedSpot(ref: Ref): Caret {
  switch (ref.at) {
    case 'root':
      return { kind: 'empty' };
    case 'slot':
      return { kind: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { kind: 'row', path: ref.path, index: ref.index };
  }
}

const deletePosOf = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'root' };
    case 'slot':
      return { at: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'row', path: ref.path, index: ref.index };
  }
};

const replacePosOf = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'replaceRoot' };
    case 'slot':
      return { at: 'replaceSlot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'replaceCell', path: ref.path, index: ref.index };
  }
};

/** The number with the character at `drop` removed, or null when the token is
 *  emptied (or the result would be unrepresentable — the caller falls back). */
function shortened(num: NodeJson, drop: number): NodeJson | null {
  const text = tokenText(num);
  const next = text.slice(0, drop) + text.slice(drop + 1);
  if (next === '') return null;
  const value = Number(next);
  return Number.isFinite(value) ? { type: 'num', value } : null;
}

/** Decide the backspace at `caret` in `env`: the rule kind, the one mechanical
 *  op that realizes it (zero ops = defined no-op), and the caret afterward.
 *  Pure — nothing is applied. Throws caret-invalid on an unresolvable caret. */
export function decideBackspace(
  env: Envelope,
  caret: Caret,
  opts: { readonly ctrl?: boolean } = {},
): BackspaceDecision {
  if (!caretResolvesIn(env, caret)) {
    throw new EngineError('caret-invalid', `decideBackspace: caret does not resolve (${JSON.stringify(caret)})`);
  }
  const ctrl = opts.ctrl === true;
  switch (caret.kind) {
    case 'empty':
      return { kind: 'noop', ops: [], caret };

    case 'token': {
      const num = nodeAt(env, caret.path) as NodeJson;
      const ref = refOfPath(caret.path);
      if (ctrl) {
        // whole number, in-token
        return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
      }
      if (caret.index === 0) return { kind: 'noop', ops: [], caret }; // no digit before the caret
      const short = shortened(num, caret.index - 1);
      if (short === null) {
        // emptied number: removed, caret in the freed spot (rule 2 keeps the parent)
        return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
      }
      const index = Math.min(caret.index, tokenText(short).length);
      return {
        kind: 'shorten',
        ops: [{ op: 'insert', node: short, at: replacePosOf(ref) }],
        caret: { kind: 'token', path: caret.path, index },
      };
    }

    case 'node': {
      const target = nodeAt(env, caret.path) as NodeJson;
      const ref = refOfPath(caret.path);
      if (target.type === 'num' && !ctrl) {
        const short = shortened(target, tokenText(target).length - 1);
        if (short === null) {
          return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
        }
        return {
          kind: 'shorten',
          ops: [{ op: 'insert', node: short, at: replacePosOf(ref) }],
          caret: { kind: 'node', path: caret.path },
        };
      }
      return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
    }

    case 'slot': {
      // Rule 3: at a placeholder region, the parent dies iff every region of
      // the parent is an empty placeholder (the caret's own region is one).
      const parent = nodeAt(env, caret.path) as NodeJson;
      if (!slotsOf(parent).every((s) => slotValue(parent, s) === null)) {
        return { kind: 'noop', ops: [], caret };
      }
      const ref = refOfPath(caret.path);
      return { kind: 'structure-death', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
    }

    case 'row': {
      const row = nodeAt(env, caret.path) as NodeJson;
      const args = rowArgs(row);
      const inCell = caret.index < args.length ? args[caret.index] === null : args.length === 0;
      if (inCell) {
        if (!args.every((a) => a === null)) return { kind: 'noop', ops: [], caret };
        const ref = refOfPath(caret.path);
        return { kind: 'structure-death', ops: [{ op: 'deleteAt', at: deletePosOf(ref) }], caret: freedSpot(ref) };
      }
      if (caret.index === 0) return { kind: 'noop', ops: [], caret }; // start of the row region
      const target = args[caret.index - 1];
      if (target === null) return { kind: 'noop', ops: [], caret }; // an empty cell left of the caret: no node
      const cellRef: Ref = { at: 'cell', path: caret.path, index: caret.index - 1 };
      if (target.type === 'num' && !ctrl) {
        const short = shortened(target, tokenText(target).length - 1);
        if (short === null) {
          return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(cellRef) }], caret: freedSpot(cellRef) };
        }
        return {
          kind: 'shorten',
          ops: [{ op: 'insert', node: short, at: replacePosOf(cellRef) }],
          caret, // the seam survives the replace
        };
      }
      return { kind: 'delete', ops: [{ op: 'deleteAt', at: deletePosOf(cellRef) }], caret: freedSpot(cellRef) };
    }
  }
}

/** Apply one backspace to the session: decide + apply the emitted op(s).
 *  A no-op decision returns the same state object (nothing applied, nothing
 *  logged). Pure function of the given state. */
export function backspace(state: EditingState, opts: { readonly ctrl?: boolean } = {}): EditingState {
  const decision = decideBackspace(envelopeOf(state), state.caret, opts);
  let next = state;
  for (const op of decision.ops) next = applyOp(next, op);
  return next;
}
