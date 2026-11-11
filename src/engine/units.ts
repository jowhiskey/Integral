// Unit-run settlement (rework session 2b-2) — the S-051 typing half.
//
// The contract: a letter run typed after a number is an ordinary symbol run
// WHILE it is typed (the glyph-less implicit pair the typing surface
// produces); the vocabulary-dependent conversion into an attached UnitNode
// fires ON LEAVING the run — any non-letter key, arrow away, click away
// (docs/context/interaction.md, S-051 C; S-104 granularizes the units it
// makes). The leave events are editor-layer moments, so this module is a
// pure engine function the CONTROLLER (or any host harnessing the engine)
// calls at its leave points; the typing surface itself stays one-token-one-
// op. One converted run = exactly one place op = one log entry; undo
// restores the symbol run and its caret byte-exactly (S-083 patterns).
//
// Converted shape (the ruled, minimal, deterministic one): an implicit
// multiply row of EXACTLY [num, sym] whose symbol name is a unit of the
// session's vocabulary (the whole run — the longest match, `mm` → the unit
// `mm`, never a shorter suffix) becomes unit{value: num, unit: sym.name}.
// Unknown runs and every other layout stay exactly as typed (the legal
// fallback); a settle never matches prefix-blind or partial runs.

import type { Envelope, NodeJson } from '../ast/json.js';
import {
  caretResolvesIn,
  nodeAt,
  refOfPath,
  rowArgs,
  slotValue,
  slotsOf,
  type Caret,
  type Path,
} from './caret.js';
import { exitStation } from './nav.js';
import { isImplicitRow, withRefSet } from './internal.js';
import { applyOp, envelopeOf, type EditingState } from './ops.js';
import { unitSetOf } from './policy.js';

/** The first convertible pair of the envelope, in pre-order: an implicit
 *  multiply row of exactly [num, sym-known]. Null when none exists. */
function findPair(env: Envelope, units: ReadonlySet<string>): Path | null {
  const visit = (node: NodeJson, path: Path): Path | null => {
    if (node.type === 'op' || node.type === 'fn') {
      const args = rowArgs(node);
      if (isImplicitRow(node) && args.length === 2) {
        const [a, b] = args as readonly (NodeJson | null)[];
        if (
          a !== null && b !== null && a.type === 'num' && b.type === 'sym' &&
          units.has((b as { name: string }).name)
        ) {
          return path;
        }
      }
      for (let i = 0; i < args.length; i++) {
        const cell = args[i];
        if (cell === null) continue;
        const found = visit(cell, [...path, i]);
        if (found !== null) return found;
      }
      return null;
    }
    for (const slot of slotsOf(node)) {
      const child = slotValue(node, slot);
      if (child === null) continue;
      const found = visit(child, [...path, slot]);
      if (found !== null) return found;
    }
    return null;
  };
  return env.root === null ? null : visit(env.root, []);
}

/** Whether `path` starts with the given prefix steps. */
const hasPrefix = (path: Path, prefix: Path): boolean =>
  prefix.length <= path.length && prefix.every((step, i) => step === path[i]);

/** The caret's station directly outside the converted unit — the mapped
 *  position for a caret that lived ON the pair's seams. */
function outsideCaret(after: Envelope, pairPath: Path, side: 'left' | 'right'): Caret {
  return exitStation(after, pairPath, side) ?? { kind: 'node', path: pairPath };
}

/** Map a caret that lived around/inside the pair onto the converted unit:
 *  label-position token carets carry their offset onto the unit's label,
 *  in-number token carets onto the unit's value, the pair seam between
 *  value and run maps to the label start, and the seam after the run maps
 *  to the label's END token caret — the text-editor right edge of the
 *  token: typing extends the run, Left steps letter-wise, Right exits.
 *  The seam before maps to the station left of the whole unit; every other
 *  caret survives where it still resolves (a replace never shifts). */
function mappedCaret(caret: Caret, pairPath: Path, runLen: number, after: Envelope): Caret {
  if (caret.kind === 'token' && caret.path.length === pairPath.length + 1 && hasPrefix(caret.path, pairPath)) {
    const step = caret.path[pairPath.length];
    if (step === 1) return { kind: 'token', path: pairPath, index: caret.index }; // in the run's letters
    if (step === 0) return { kind: 'token', path: [...pairPath, 'value'], index: caret.index }; // in the number
  }
  if (caret.kind === 'row' && caret.path.length === pairPath.length && hasPrefix(caret.path, pairPath)) {
    if (caret.index >= 2) return { kind: 'token', path: pairPath, index: runLen }; // right after the run
    if (caret.index === 1) return { kind: 'token', path: pairPath, index: 0 }; // between value and run
    return outsideCaret(after, pairPath, 'left');
  }
  return caretResolvesIn(after, caret) ? caret : outsideCaret(after, pairPath, 'right');
}

/**
 * Settle every convertible unit run in the state (S-051 conversion on
 * leave). Pure: returns the next state — the SAME object when nothing is
 * convertible (no op, no log growth, no caret change). Every conversion is
 * one place op (one log entry); the caret maps onto the unit per the
 * position it addressed in the run.
 */
export function settleUnits(state: EditingState): EditingState {
  const units = unitSetOf(state);
  for (;;) {
    const env = envelopeOf(state);
    const pairPath = findPair(env, units);
    if (pairPath === null) return state;
    const pair = nodeAt(env, pairPath) as NodeJson;
    const [value, run] = rowArgs(pair) as readonly (NodeJson | null)[];
    const unitNode = {
      type: 'unit',
      value: value as NodeJson,
      unit: (run as { name: string }).name,
    } as NodeJson;
    const ref = refOfPath(pairPath);
    const after = withRefSet(env, ref, unitNode);
    state = applyOp(state, {
      op: 'place',
      node: unitNode,
      at: ref.at === 'root'
        ? { at: 'replaceRoot' }
        : ref.at === 'slot'
          ? { at: 'replaceSlot', path: ref.path, slot: ref.slot }
          : { at: 'replaceCell', path: ref.path, index: ref.index },
      to: mappedCaret(state.caret, pairPath, (run as { name: string }).name.length, after),
    });
  }
}
