// Operator swap (arc session 4): the edit model at mid-row operator
// positions — the operator-adjacent carets where typeToken rejected typed
// structure tokens with not-a-typing-point (a node caret on a mid-row
// operand, a row seam between two operands). Typing an operator there swaps
// the operator the caret addresses: a complete re-fold of the affected
// visual row with the changed operator substituted. The fold is the same
// precedence/associativity binding the insertion policy applies to typed
// input (session 3's spine climb), run over the row's operand sequence — so
// every swap kind falls out of one rule and typed-insertion vs swap-edit of
// the same expression yield identical ASTs by construction:
//   - higher-precedence replacement wraps the two adjacent operands (the
//     pair the changed operator binds re-binds tighter),
//   - lower-precedence replacement splits the chain (both sides, no
//     asymmetry — untouched same-op operands stay grouped among themselves),
//   - consecutive same-op results merge into one flat node (flattening IS
//     the fold; ÷ and ^ never merge — they bind as frac/pow),
//   - precedence ties re-bind like typing does: left-associative.
//
// Position model (symmetric for row and node carets): a row seam at index s
// (over a non-null cell) sits on the glyph of operator s−1; a node caret on
// a mid-row operand k (complete — incomplete nodes keep the session-3 dive)
// addresses the operator to its right, operator k. The caret lands at the
// changed operator's junction in the new shape: the row seam between the
// operands the operator now binds (round-trip retyping swaps back; over a
// pending null cell it is the fill position), or the natural dive for
// ÷/^ structure swaps. One swap = one mechanical op = one log entry.

import type { Envelope, NodeJson } from '../ast/json.js';
import {
  nodeAt,
  pathOfRef,
  refOfPath,
  rowArgs,
  slotValue,
  type Caret,
  type Path,
  type SlotName,
} from './caret.js';
import { firstEmpty, type ReplacePosition, type SwapOp } from './ops.js';
import { BINDER_FNS, FLAT_FNS, PRECEDENCE } from './precedence.js';
import type { StructureToken } from './policy.js';

// ——— The addressed operator ———

interface SwapTarget {
  /** The op row containing the addressed operator (binder-known fn only). */
  readonly chain: NodeJson;
  /** Its absolute path. */
  readonly chainPath: Path;
  /** 0-based operator index within the row. */
  readonly index: number;
}

/** True iff `node` is an op row with a binder-known fn (the swap re-folds it). */
function isOpRow(node: NodeJson | null): node is NodeJson {
  return node !== null && node.type === 'op' && BINDER_FNS.has((node as unknown as { op: string }).op);
}

/** The operator glyph the caret addresses, or null when the caret is not at
 *  a mid-row operator position (typing points keep their session-3
 *  semantics; a null result falls through to the typing-point rejection). */
function operatorPosition(env: Envelope, caret: Caret): SwapTarget | null {
  switch (caret.kind) {
    case 'empty':
    case 'slot':
      return null;
    case 'row': {
      const chain = nodeAt(env, caret.path);
      if (!isOpRow(chain)) return null;
      const args = rowArgs(chain);
      const s = caret.index;
      // A seam between args s−1 and s sits on operator s−1 — but only when
      // that operator exists and a real (non-null) cell fences the seam. Over
      // a null cell the fill semantics own the position (session-3 pin), and
      // the end seam / seam 0 address no operator at all.
      if (s < 1 || s > args.length - 1 || args[s] === null) return null;
      return { chain, chainPath: caret.path, index: s - 1 };
    }
    case 'node': {
      const node = nodeAt(env, caret.path);
      if (node === null || firstEmpty(node) !== null) return null; // the dive owns incomplete nodes
      const ref = refOfPath(caret.path);
      if (ref.at !== 'cell') return null;
      const chain = nodeAt(env, ref.path);
      if (!isOpRow(chain)) return null;
      // Mid-row operand: the operator to its right. The last arg has none —
      // typing there keeps the session-3 hold semantics.
      if (ref.index > rowArgs(chain).length - 2) return null;
      return { chain, chainPath: ref.path, index: ref.index };
    }
  }
}

/** The maximal op-row ancestor of the chain at `chainPath`, plus the arg
 *  steps from it back down: the visual row the swap re-folds spills through
 *  op-chain parents only — fractions, powers, groups, fn rows and units are
 *  the same barriers the insertion spine climbs through (session-3 pins). */
function maxChain(env: Envelope, chainPath: Path): { path: Path; desc: number[] } {
  let path: Path = chainPath;
  const desc: number[] = [];
  for (;;) {
    if (path.length === 0) break;
    const step = path[path.length - 1];
    if (typeof step !== 'number') break;
    const parent = nodeAt(env, path.slice(0, -1));
    if (!isOpRow(parent)) break;
    desc.unshift(step);
    path = path.slice(0, -1);
  }
  return { path, desc };
}

// ——— The flattened visual row: operands and operator glyphs, spliced out
// of the nested flat chains, with the addressed glyph marked. Args that are
// not flat rows (fracs, pows, groups, fns, leaves, nulls, unknown-op rows)
// are atomic operands; their structure does not re-bind. ———

interface SeqOp {
  readonly fn: string;
  readonly changed: boolean;
}

function spliceTarget(
  node: NodeJson,
  queue: readonly number[],
  changedAt: number,
  changedFn: string,
  ops: SeqOp[],
  operands: (NodeJson | null)[],
): void {
  const args = rowArgs(node);
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (queue.length > 0 && queue[0] === k) {
      spliceTarget(arg as NodeJson, queue.slice(1), changedAt, changedFn, ops, operands);
    } else if (isFlatChain(arg)) {
      splicePlain(arg as NodeJson, ops, operands);
    } else {
      operands.push(arg);
    }
    if (k < args.length - 1) {
      ops.push({
        fn: queue.length === 0 && k === changedAt ? changedFn : (node as unknown as { op: string }).op,
        changed: queue.length === 0 && k === changedAt,
      });
    }
  }
}

function splicePlain(node: NodeJson, ops: SeqOp[], operands: (NodeJson | null)[]): void {
  const args = rowArgs(node);
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (isFlatChain(arg)) splicePlain(arg as NodeJson, ops, operands);
    else operands.push(arg);
    if (k < args.length - 1) {
      ops.push({ fn: (node as unknown as { op: string }).op, changed: false });
    }
  }
}

function isFlatChain(node: NodeJson | null): boolean {
  return node !== null && node.type === 'op' && FLAT_FNS.has((node as unknown as { op: string }).op);
}

// ——— The re-fold: precedence climbing over the sequence, left-associative,
// pow right-associative — the same table the insertion policy is pinned
// against. Tracks where the changed operator's glyph ends up (the junction):
// the seam between the operands it binds, as a path relative to the fold's
// top node; merges into flat same-op parents shift it exactly as the
// operands splice. ———

/** Where the changed operator's glyph ended up, relative to the fold's top
 *  node: the row seam it now occupies ('seam', always defined then), or the
 *  created frac/pow structure itself ('node', for ÷/^ swaps). */
interface Junction {
  readonly kind: 'seam' | 'node';
  readonly path: readonly (number | SlotName)[];
  readonly seam?: number;
}

interface Fold {
  readonly node: NodeJson | null;
  readonly junction: Junction | null;
}

/** The same-op row node for a flat fn, if `node` is one. */
function rowChainOf(fn: string, node: NodeJson | null): NodeJson | null {
  return isFlatChain(node) && (node as unknown as { op: string }).op === fn ? node : null;
}

/** Bind `l fn r`, absorbing same-op row children into the new flat node
 *  (structural rule 3), and carry the junction through. */
function bind(fn: string, changed: boolean, l: Fold, r: Fold): Fold {
  if (fn === 'divide' || fn === 'pow') {
    const [lSlot, rSlot]: [SlotName, SlotName] = fn === 'divide' ? ['num', 'den'] : ['base', 'exp'];
    const node: NodeJson =
      fn === 'divide' ? { type: 'frac', num: l.node, den: r.node } : { type: 'pow', base: l.node, exp: r.node };
    // Divide and pow never flatten; the junction (if any) passes through.
    const junction: Junction | null = changed
      ? { kind: 'node', path: [] }
      : l.junction !== null
        ? { ...l.junction, path: [lSlot, ...l.junction.path] }
        : r.junction !== null
          ? { ...r.junction, path: [rSlot, ...r.junction.path] }
          : null;
    return { node, junction };
  }
  const lRow = rowChainOf(fn, l.node);
  const rRow = rowChainOf(fn, r.node);
  const lArgs = (lRow !== null ? [...rowArgs(lRow)] : [l.node]) as (NodeJson | null)[];
  const rArgs = (rRow !== null ? [...rowArgs(rRow)] : [r.node]) as (NodeJson | null)[];
  const node: NodeJson = { type: 'op', op: fn, args: [...lArgs, ...rArgs] };
  let junction: Junction | null = null;
  if (changed) {
    // The changed glyph: between the left side's contribution and the right's.
    junction = { kind: 'seam', path: [], seam: lArgs.length };
  } else if (l.junction !== null) {
    // Left side: same-op children splice at the front — indices unchanged;
    // an atomic left side keeps the junction one arg deeper.
    junction = lRow !== null ? l.junction : { ...l.junction, path: [0, ...l.junction.path] };
  } else if (r.junction !== null) {
    if (rRow !== null) {
      // Right side spliced at offset lArgs.length: the junction's own seam
      // (when the container was the merged child itself) shifts by it; a
      // deeper container only shifts its top arg index.
      junction =
        r.junction.path.length === 0
          ? r.junction.kind === 'seam'
            ? { kind: 'seam', path: [], seam: (r.junction.seam as number) + lArgs.length }
            : r.junction
          : {
              kind: r.junction.kind,
              seam: r.junction.seam,
              path: [(r.junction.path[0] as number) + lArgs.length, ...r.junction.path.slice(1)],
            };
    } else {
      junction = { ...r.junction, path: [lArgs.length, ...r.junction.path] };
    }
  }
  return { node, junction };
}

function refold(operands: readonly (NodeJson | null)[], ops: readonly SeqOp[]): Fold {
  // p = operands consumed so far; the operator binding the last-read operand
  // with the next one is ops[p−1]. Consuming it folds the right side, whose
  // own parse advances p past its operands.
  let p = 0;
  const parse = (minPrec: number): Fold => {
    let left: Fold = { node: operands[p] ?? null, junction: null };
    p += 1;
    for (;;) {
      const seq = ops[p - 1];
      if (seq === undefined) break;
      const row = PRECEDENCE[seq.fn];
      if (row === undefined || row.prec < minPrec) break;
      const right = parse(row.assoc === 'left' ? row.prec + 1 : row.prec);
      left = bind(seq.fn, seq.changed, left, right);
    }
    return left;
  };
  return parse(0);
}

// ——— The decision ———

export type SwapKind = 'swap' | 'same-op';

export interface SwapDecision {
  readonly kind: SwapKind;
  /** Zero ops: a byte-identical re-fold (same operator retyped) — nothing
   *  applied, nothing logged. Otherwise exactly one swap op. */
  readonly ops: readonly SwapOp[];
  /** The caret the swap state carries (the op's own relocation). */
  readonly caret: Caret;
}

/** The replace placement swapping out the maximal row at `ref`. */
function positionOf(ref: ReturnType<typeof refOfPath>): ReplacePosition {
  switch (ref.at) {
    case 'root':
      return { at: 'replaceRoot' };
    case 'slot':
      return { at: 'replaceSlot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'replaceCell', path: ref.path, index: ref.index };
  }
}

/** The absolute path of `junction`'s container under the re-folded `root`
 *  placed at `base`. */
function junctionPath(base: Path, junction: Junction): Path {
  return [...base, ...junction.path];
}

/** Follow the junction through a re-folded subtree. */
function descend(from: NodeJson, path: readonly (number | SlotName)[]): NodeJson | null {
  let cur: NodeJson = from;
  for (const step of path) {
    const next: NodeJson | null =
      typeof step === 'number' ? rowArgs(cur)[step] ?? null : slotValue(cur, step);
    if (next === null) return null;
    cur = next;
  }
  return cur;
}

/** The swap's caret: the changed operator's junction. Operator swaps land on
 *  the row seam the glyph now occupies (over a pending null cell that seam
 *  is the fill position); ÷/^ swaps dive to the created structure's first
 *  empty slot, else onto the structure itself (the natural-continue rule). */
function junctionCaret(root: NodeJson, base: Path, junction: Junction): Caret {
  const at = junctionPath(base, junction);
  if (junction.kind === 'seam') return { kind: 'row', path: at, index: junction.seam as number };
  const node = descend(root, junction.path);
  const empty = node === null ? null : firstEmpty(node);
  if (empty === null) return { kind: 'node', path: at };
  return 'slot' in empty
    ? { kind: 'slot', path: at, slot: empty.slot }
    : { kind: 'row', path: at, index: empty.index };
}

/** Decide the operator swap a typed structure token means at this caret:
 *  null when the caret addresses no operator (the typing-point semantics
 *  own it); a zero-op decision when the re-fold is byte-identical (same
 *  operator); otherwise exactly one swap op. Pure — nothing is applied. */
export function decideSwap(env: Envelope, caret: Caret, token: StructureToken): SwapDecision | null {
  if (token.t !== 'operator' && token.t !== 'divide' && token.t !== 'pow') return null;
  const target = operatorPosition(env, caret);
  if (target === null) return null;
  const tokenFn = token.t === 'operator' ? (token.fn as string) : token.t === 'divide' ? 'divide' : 'pow';
  const max = maxChain(env, target.chainPath);
  const seqOps: SeqOp[] = [];
  const operands: (NodeJson | null)[] = [];
  spliceTarget(nodeAt(env, max.path) as NodeJson, max.desc, target.index, tokenFn, seqOps, operands);
  const folded = refold(operands, seqOps);
  if (folded.node === null || folded.junction === null) {
    throw new Error('engine invariant: the swap fold lost the changed operator');
  }
  const before = JSON.stringify(nodeAt(env, max.path));
  if (JSON.stringify(folded.node) === before) {
    return { kind: 'same-op', ops: [], caret };
  }
  const ref = refOfPath(max.path);
  const to = junctionCaret(folded.node, pathOfRef(ref), folded.junction);
  const op: SwapOp = { op: 'swap', node: folded.node, at: positionOf(ref), to };
  return { kind: 'swap', ops: [op], caret: to };
}
