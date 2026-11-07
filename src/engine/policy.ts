// Insertion policy (arc session 3): decide the structural edit an incoming
// structure-making token means, once, at edit time — then realize it as one
// mechanical session-1 op. The caret placement rides the ops' own relocation
// rules (insert → node-on-new; replace → dive to the first empty cell); the
// policy never emits moveCaret for placement, so one token = one log entry
// and Ctrl-Z backs out one editor-visible step.
//
// Attach rules (owner-ratified): an incoming operator with lower or equal
// precedence than the context wraps the context; higher precedence nests in
// the context's right operand; user parens create a GroupNode; at a flat
// chain boundary equal precedence extends the chain, lower wraps the whole
// chain, higher nests in the rightmost operand. Minus disambiguates
// binary-vs-unary by position exactly as mathjs does: a token landing at an
// operand-expected position (empty formula, empty slot, null args cell) is
// unary iff it has a unary form (− → unaryMinus, + → unaryPlus); anything
// with a typed value to its left is binary. Caret positions that are not
// typing points (row splices, mid-row nodes) are typed errors, not guesses.

import type { Envelope, NodeJson } from '../ast/json.js';
import {
  caretResolvesIn,
  isRowNode,
  nodeAt,
  pathOfRef,
  refOfPath,
  rowArgs,
  setSlot,
  tokenText,
  type Caret,
  type Path,
  type Ref,
  type SlotName,
} from './caret.js';
import { EngineError } from './errors.js';
import { applyOp, envelopeOf, firstEmpty, type EditingState, type InsertOp, type Op } from './ops.js';
import { PRECEDENCE, type PrecedenceRow } from './precedence.js';
import { decideSwap } from './swap.js';

export { PRECEDENCE } from './precedence.js';
export type { PrecedenceRow } from './precedence.js';

/** Row-kind operator tokens the policy accepts (mathjs fn names). Divide
 *  and pow are structure tokens (FractionNode / PowerNode), not row ops. */
export type OperatorFn = 'add' | 'subtract' | 'multiply' | 'mod';

/** Structure-making typed tokens. Leaves are not policy: a leaf typed into
 *  an operand-expected position is a plain session-1 fill (typeToken emits
 *  it mechanically). */
export type StructureToken =
  | { readonly t: 'operator'; readonly fn: OperatorFn }
  | { readonly t: 'divide' }
  | { readonly t: 'pow' }
  | { readonly t: 'groupOpen' }
  | { readonly t: 'groupClose' };

/** One typed item: a structure token (policy) or a leaf value (fill). */
export type TypedToken = StructureToken | { readonly t: 'leaf'; readonly node: NodeJson };

// ——— Precedence table ———
//
// The engine-owned table lives in ./precedence.js (shared with the operator
// swap, arc session 4): ordering/associativity pinned against math.parse by
// the oracle — add/subtract < multiply/divide/mod < unaryMinus/unaryPlus <
// pow, and pow is the only right-associative operator. Contexts without a
// row are barriers — never guesses — and the token set above is closed.

/** One policy decision: the rule kind that fired, the mechanical ops that
 *  realize it, and the caret the state will carry after they apply. */
export type AttachKind = 'unary' | 'template' | 'nest' | 'extend' | 'wrap' | 'group-open' | 'group-close';

export interface AttachDecision {
  readonly kind: AttachKind;
  /** Zero ops: the token is a defined no-op (closing no open group). */
  readonly ops: readonly Op[];
  /** The caret after the ops apply (the mechanical relocation outcome). */
  readonly caret: Caret;
}

// ——— Internal addressing over the JSON envelope ———
// Ref / refOfPath / pathOfRef live in ./caret.js (shared with the swap).

/** A typed value that continues here: the node the caret sits on, and
 *  ref it occupies. Genuinely ambiguous positions (splices, mid-row nodes)
 *  are typed errors, not guesses. */
interface Hold {
  readonly node: NodeJson;
  readonly ref: Ref;
  readonly path: Path;
}

type TypingPoint = { readonly kind: 'operand'; readonly ref: Ref } | ({ readonly kind: 'hold' } & Hold);

/** Resolve the caret to the typing point. A node caret on a container hops
 *  to that container's first empty cell/slot — typing continues where the
 *  structure is waiting for content (the same natural-continue rule the
 *  replace relocation uses, so attach → dive → next token composes). */
function typingPoint(env: Envelope, caret: Caret): TypingPoint {
  if (!caretResolvesIn(env, caret)) {
    throw new EngineError('not-a-typing-point', `caret does not resolve in this envelope (${JSON.stringify(caret)})`);
  }
  switch (caret.kind) {
    case 'empty':
      return { kind: 'operand', ref: { at: 'root' } };
    case 'slot':
      return { kind: 'operand', ref: { at: 'slot', path: caret.path, slot: caret.slot } };
    case 'row': {
      // The only row positions typing understands: an empty args cell.
      // Splices (before a node or at the end seam) edit nothing a typed
      // operator can address — reject rather than invent semantics.
      const parent = nodeAt(env, caret.path) as NodeJson;
      const args = rowArgs(parent);
      if (args[caret.index] !== null) {
        throw new EngineError('not-a-typing-point', `a splice at args[${caret.index}] is not a typing point`);
      }
      return { kind: 'operand', ref: { at: 'cell', path: caret.path, index: caret.index } };
    }
    case 'node':
      return typingPointAtNode(env, caret.path);
    case 'token':
      // An in-token position degenerates to the number's owning structural
      // station for typing decisions (the split/merge rules live in
      // typeAtToken, which intercepts token carets before this point).
      return typingPointAtNode(env, caret.path);
  }
}

/** The node-caret typing point at `path` (shared by `node` and `token` carets). */
function typingPointAtNode(env: Envelope, path: Path): TypingPoint {
  const node = nodeAt(env, path) as NodeJson;
  const empty = firstEmpty(node);
  if (empty !== null) {
    return {
      kind: 'operand',
      ref:
        'slot' in empty
          ? { at: 'slot', path, slot: empty.slot }
          : { at: 'cell', path, index: empty.index },
    };
  }
  const ref = refOfPath(path);
  if (ref.at === 'cell') {
    const parent = nodeAt(env, ref.path) as NodeJson;
    if (isRowNode(parent) && ref.index !== rowArgs(parent).length - 1) {
      throw new EngineError(
        'not-a-typing-point',
        `args[${ref.index}] is not the rightmost content of its row — mid-row values are not typing points`,
      );
    }
  }
  return { kind: 'hold', node, ref, path };
}

// ——— The spine: comparable right-region ancestor contexts ———
//
// The spine walks up from the typing point through RIGHT regions: the last
// arg of an op chain, a fraction's denominator, a power's exponent — the
// positions where typing continues inside that structure. Everything else
// is a boundary (group children, function rows, numerators, bases,
// radicands, unit values, unknown-op rows): the climb never crosses one, so
// a token wraps the innermost context it is allowed to see.

interface SpineStep {
  /** The context the candidate sits inside (op chain, frac, or pow). */
  readonly ctx: NodeJson;
  /** Where the context node itself lives. */
  readonly ctxRef: Ref;
}

/** Precedence of a comparable context node (spine only pushes op chains with
 *  a known row, fracs, and pows). */
function contextRow(node: NodeJson): PrecedenceRow {
  if (node.type === 'frac') return PRECEDENCE.divide;
  if (node.type === 'pow') return PRECEDENCE.pow;
  return PRECEDENCE[(node as { op: string }).op];
}

/** True iff `step` addresses the context's right region (where typing
 *  continues inside it). */
function isRightRegion(parent: NodeJson, step: number | SlotName): boolean {
  if (typeof step === 'number') {
    return (
      parent.type === 'op' && PRECEDENCE[(parent as { op: string }).op] !== undefined && step === rowArgs(parent).length - 1
    );
  }
  if (parent.type === 'frac') return step === 'den';
  if (parent.type === 'pow') return step === 'exp';
  return false;
}

/** Comparable right-region ancestor contexts of the hold, innermost first. */
function spineOf(env: Envelope, hold: Hold): SpineStep[] {
  const steps: SpineStep[] = [];
  let path: Path = hold.path;
  for (;;) {
    if (path.length === 0) break;
    const parentPath = path.slice(0, -1);
    const parent = nodeAt(env, parentPath);
    if (parent === null || !isRightRegion(parent, path[path.length - 1])) break;
    steps.push({ ctx: parent, ctxRef: refOfPath(parentPath) });
    path = parentPath;
  }
  return steps;
}

// ——— Emission builders (one mechanical op per decision) ———

function insertAt(ref: Ref, node: NodeJson): InsertOp {
  switch (ref.at) {
    case 'root':
      return { op: 'insert', node, at: { at: 'root' } };
    case 'slot':
      return { op: 'insert', node, at: { at: 'slot', path: ref.path, slot: ref.slot } };
    case 'cell':
      return { op: 'insert', node, at: { at: 'fill', path: ref.path, index: ref.index } };
  }
}

function replaceAt(ref: Ref, node: NodeJson): InsertOp {
  switch (ref.at) {
    case 'root':
      return { op: 'insert', node, at: { at: 'replaceRoot' } };
    case 'slot':
      return { op: 'insert', node, at: { at: 'replaceSlot', path: ref.path, slot: ref.slot } };
    case 'cell':
      return { op: 'insert', node, at: { at: 'replaceCell', path: ref.path, index: ref.index } };
  }
}

/** The structure a token creates around a given left operand. */
function wrapperFor(token: StructureToken, left: NodeJson): NodeJson {
  switch (token.t) {
    case 'operator':
      return { type: 'op', op: token.fn, args: [left, null] };
    case 'divide':
      return { type: 'frac', num: left, den: null };
    case 'pow':
      return { type: 'pow', base: left, exp: null };
    default:
      throw new Error('policy invariant: token kind has no binary wrapper');
  }
}

/** Mechanical caret after an insert lands a node at ref (session-1 rules:
 *  the typing caret was at the target, so it moves onto the new node). */
function caretAfterInsert(ref: Ref): Caret {
  return { kind: 'node', path: pathOfRef(ref) };
}

/** Mechanical caret after a replace swaps in `node`: the dive rule — the
 *  wrapper's first empty cell, or the wrapper itself when it has none. */
function caretAfterReplace(node: NodeJson, ref: Ref): Caret {
  const empty = firstEmpty(node);
  const path = pathOfRef(ref);
  return empty === null
    ? { kind: 'node', path }
    : 'slot' in empty
      ? { kind: 'slot', path, slot: empty.slot }
      : { kind: 'row', path, index: empty.index };
}

// ——— The decision ———

/** Decide the structural edit a typed structure token means in the given
 *  editing state (envelope + caret): the attach kind, the mechanical op(s)
 *  that realize it, and the caret afterward. Pure — nothing is applied. */
export function decideAttach(env: Envelope, caret: Caret, token: StructureToken): AttachDecision {
  const tp = typingPoint(env, caret);
  switch (token.t) {
    case 'groupClose': {
      const inner = enclosingGroup(env, caret);
      if (inner === null) return { kind: 'group-close', ops: [], caret };
      const to: Caret = { kind: 'node', path: inner };
      return { kind: 'group-close', ops: [{ op: 'moveCaret', to }], caret: to };
    }
    case 'groupOpen': {
      if (tp.kind === 'operand') {
        // Opens a group as the next operand at the typing point; no content
        // is consumed. Linear typing starts groups before their content, so
        // this is the oracle-relevant case.
        const node: NodeJson = { type: 'group', parens: 'always', child: null };
        return { kind: 'group-open', ops: [insertAt(tp.ref, node)], caret: caretAfterInsert(tp.ref) };
      }
      // '(' with a typed value to the left wraps that value — mathjs's
      // implicit juxtaposition ('a(…)') has no row to live in here, and a
      // bare sibling group is not a representable intent.
      const wrapped: NodeJson = { type: 'group', parens: 'always', child: tp.node };
      return { kind: 'group-open', ops: [replaceAt(tp.ref, wrapped)], caret: caretAfterReplace(wrapped, tp.ref) };
    }
    case 'operator':
    case 'divide':
    case 'pow': {
      const row: PrecedenceRow =
        token.t === 'operator'
          ? PRECEDENCE[token.fn]
          : token.t === 'divide'
            ? PRECEDENCE.divide
            : PRECEDENCE.pow;
      if (tp.kind === 'operand') {
        // Operand-expected position: unary forms for −/+ (exactly where
        // mathjs parses them unary), blank structure templates for / and ^,
        // otherwise rejected — mathjs parses '*3' as an error, not a form.
        if (row.unary !== undefined) {
          const node: NodeJson = { type: 'op', op: row.unary, args: [null] };
          return { kind: 'unary', ops: [insertAt(tp.ref, node)], caret: caretAfterInsert(tp.ref) };
        }
        if (token.t === 'divide' || token.t === 'pow') {
          const node: NodeJson =
            token.t === 'divide' ? { type: 'frac', num: null, den: null } : { type: 'pow', base: null, exp: null };
          return { kind: 'template', ops: [insertAt(tp.ref, node)], caret: caretAfterInsert(tp.ref) };
        }
        throw new EngineError(
          'not-a-typing-point',
          `'${token.fn}' has no unary form to attach where an operand is expected`,
        );
      }
      // A typed value continues: climb by precedence, innermost context
      // first. Higher-than-context nests in the context's right operand;
      // lower or equal climbs (equal + left-assoc binds the whole context
      // as the new token's left operand); equal + same-op chain extends the
      // flat chain; equal + right-assoc (pow into pow's exponent) nests.
      let cand: Hold = tp;
      for (const step of spineOf(env, tp)) {
        const ctxRow = contextRow(step.ctx);
        if (row.prec > ctxRow.prec) return nest(token, cand);
        if (row.prec === ctxRow.prec && row.assoc === 'right') return nest(token, cand);
        if (
          row.prec === ctxRow.prec &&
          token.t === 'operator' &&
          step.ctx.type === 'op' &&
          (step.ctx as { op: string }).op === token.fn
        ) {
          return extend(step);
        }
        // Lower precedence, or equal precedence that is not chain-extend:
        // the whole context becomes the next candidate up the spine.
        cand = { node: step.ctx, ref: step.ctxRef, path: pathOfRef(step.ctxRef) };
      }
      return wrap(token, cand); // boundary — no comparable context remains
    }
  }
}

function nest(token: StructureToken, cand: Hold): AttachDecision {
  const wrapper = wrapperFor(token, cand.node);
  return { kind: 'nest', ops: [replaceAt(cand.ref, wrapper)], caret: caretAfterReplace(wrapper, cand.ref) };
}

function wrap(token: StructureToken, cand: Hold): AttachDecision {
  const wrapper = wrapperFor(token, cand.node);
  return { kind: 'wrap', ops: [replaceAt(cand.ref, wrapper)], caret: caretAfterReplace(wrapper, cand.ref) };
}

function extend(step: SpineStep): AttachDecision {
  // Same-op chain boundary: the flat chain keeps its shape and gains its
  // next operand cell — that is why chains are flat. The typing caret was
  // inside the replaced chain node, so the replace relocation dives to the
  // freshly appended cell.
  const chain = step.ctx as unknown as { type: 'op'; op: string; args: (NodeJson | null)[]; [k: string]: unknown };
  const extended: NodeJson = { ...chain, type: 'op', args: [...chain.args, null] };
  return {
    kind: 'extend',
    ops: [replaceAt(step.ctxRef, extended)],
    caret: caretAfterReplace(extended, step.ctxRef),
  };
}

/** Path of the innermost group whose content subtree contains the caret,
 *  excluding the caret's own node — one ')' pops exactly one level; a caret
 *  inside no group closes nothing (defined no-op). */
function enclosingGroup(env: Envelope, caret: Caret): Path | null {
  const path = caret.kind === 'empty' ? [] : caret.path;
  for (let len = path.length - 1; len >= 0; len--) {
    const prefix = path.slice(0, len);
    const node = nodeAt(env, prefix);
    if (node !== null && node.type === 'group') return prefix;
  }
  return null;
}

// ——— Typing at in-token positions (DOM-arc session 3) ———

/** The envelope `env` with the node at `path` replaced by `node` (working copy). */
function withNodeAt(env: Envelope, path: Path, node: NodeJson): Envelope {
  const clone: Envelope = JSON.parse(JSON.stringify(env)) as Envelope;
  const ref = refOfPath(path);
  if (ref.at === 'root') {
    clone.root = node;
    return clone;
  }
  const parent = nodeAt(clone, ref.path);
  if (parent === null) throw new Error('policy invariant: withNodeAt on an unresolvable path');
  if (ref.at === 'slot') setSlot(parent, ref.slot, node);
  else rowArgs(parent)[ref.index] = node;
  return clone;
}

/** A copy of `node` with its first empty child (the natural-continue slot)
 *  filled by `value` — a split's right half lands in the wrapper's pending
 *  cell inside the ONE emitted replace op. */
function fillFirstEmpty(node: NodeJson, value: NodeJson): NodeJson {
  const clone: NodeJson = JSON.parse(JSON.stringify(node)) as NodeJson;
  const empty = firstEmpty(clone);
  if (empty === null) return clone;
  if ('slot' in empty) setSlot(clone, empty.slot, value);
  else rowArgs(clone)[empty.index] = value;
  return clone;
}

/** Type one token while the caret is inside a number token (offset 0..len):
 *  - a digit (leaf num) merges into the number at the offset — one replace op
 *    = one log entry; the replace relocation advances the in-token caret by one;
 *  - a binary structure token (operator / ÷ / ^) at a strict interior offset
 *    SPLITS the number there: the left half is the attach context (the
 *    existing insertion policy runs on it unchanged), the right half fills
 *    the wrapper's pending cell — one replace op = one log entry, caret at the
 *    natural-continue spot (the replace's dive);
 *  - anything else (letters, group tokens, the boundary offsets 0/len, and
 *    interior offsets whose owning station is a swap position) snaps to the
 *    token's owning structural station and applies the existing policy
 *    unchanged. */
function typeAtToken(
  state: EditingState,
  env: Envelope,
  caret: Extract<Caret, { kind: 'token' }>,
  token: TypedToken,
): EditingState {
  const node = nodeAt(env, caret.path) as NodeJson;
  const text = tokenText(node);
  const i = caret.index;
  if (token.t === 'leaf' && token.node.type === 'num') {
    const value = Number(text.slice(0, i) + String(token.node.value) + text.slice(i));
    if (Number.isFinite(value)) {
      return applyOp(state, replaceAt(refOfPath(caret.path), { type: 'num', value }));
    }
  } else if (token.t === 'operator' || token.t === 'divide' || token.t === 'pow') {
    if (i > 0 && i < text.length) {
      const leftValue = Number(text.slice(0, i));
      const rightValue = Number(text.slice(i));
      if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
        const splitEnv = withNodeAt(env, caret.path, { type: 'num', value: leftValue });
        const station: Caret = { kind: 'node', path: caret.path };
        // A mid-row number's owning station is a swap position — the swap owns
        // it there (no split); otherwise the attach policy runs on the left half.
        if (decideSwap(splitEnv, station, token) === null) {
          const base = decideAttach(splitEnv, station, token).ops;
          const op = base.length === 1 && base[0].op === 'insert' ? (base[0] as InsertOp) : null;
          if (op !== null) {
            const filled = fillFirstEmpty(op.node, { type: 'num', value: rightValue });
            return applyOp(state, { op: 'insert', node: filled, at: op.at });
          }
        }
      }
    }
  }
  // snap: the owning structural station applies the existing policy unchanged
  return typeToken({ ...state, caret: { kind: 'node', path: caret.path } }, token);
}

// ——— The typing surface ———

/** Type one token into the session: leaves fill the operand-expected
 *  position mechanically (plain session-1 inserts); structure tokens pass
 *  through decideAttach. Operator/divide/pow tokens at mid-row operator
 *  positions — where typing cannot start — are operator swaps (arc session
 *  4): decideSwap decides them first; it returns null at every typing point
 *  and every position outside its scope (group tokens, unknown-op rows, end
 *  seams), so session-3 behavior is untouched there. Pure function of the
 *  given state — throws the policy/mechanical errors on out-of-model input. */
export function typeToken(state: EditingState, token: TypedToken): EditingState {
  const env = envelopeOf(state);
  if (state.caret.kind === 'token') {
    if (!caretResolvesIn(env, state.caret)) {
      throw new EngineError(
        'not-a-typing-point',
        `caret does not resolve in this envelope (${JSON.stringify(state.caret)})`,
      );
    }
    return typeAtToken(state, env, state.caret, token);
  }
  if (token.t === 'leaf') {
    const tp = typingPoint(env, state.caret);
    if (tp.kind !== 'operand') {
      throw new EngineError('not-a-typing-point', 'a leaf needs an operand-expected position to fill');
    }
    return applyOp(state, insertAt(tp.ref, token.node));
  }
  const swap = decideSwap(env, state.caret, token);
  if (swap !== null) {
    if (swap.ops.length === 0) return state; // same operator retyped: a byte-identical no-op
    let next = state;
    for (const op of swap.ops) next = applyOp(next, op);
    return next;
  }
  let next = state;
  for (const op of decideAttach(env, state.caret, token).ops) next = applyOp(next, op);
  return next;
}
