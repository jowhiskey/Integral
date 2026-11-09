// Backspace + forward Delete — the deletion family under D1–D9 of
// docs/context/interaction.md (rework session 3). The ruling model: the
// formula behaves like a text editor — BS consumes the nearest MEANINGFUL
// VISIBLE element left of the caret station, and that element's class decides
// the action:
//
//  D1 — a text-like token (symbol, number incl. the in-progress decimal dot,
//        a unit's label — S-104 granular —, a sub label) loses ONE character;
//        a deletion that empties the token removes the NODE, caret in the
//        freed position. In an args row the freed position is the PENDING
//        NULL cell (the glyph survives as dangling: `x+y` minus y is `x+`),
//        at a fixed slot the □, at the root the empty formula.
//  D2 — at the shared gap the left-adjacent token's LAST character goes
//        (S-064); a DANGLING operator glyph standing left-adjacent deletes
//        instead (S-066 A: `−x+|` → `−x|`) — its pending cell splices away
//        and a one-cell remainder unwraps into that cell; the atomic function
//        head goes whole; a fenceless structure takes D5, a fenced container
//        takes the D7/D8 chain.
//  D3 — Ctrl+BS deletes everything left of the caret WITHIN the token (the
//        whole token only at its right edge); at gaps the left-adjacent TEXT
//        token goes whole (word-delete); the D2 glyph rules and the D5
//        highlight keep their unctrl'd semantics (unruled offsets named in
//        the session report). Ctrl+Delete is the forward mirror
//        (S-067/S-068/S-071).
//  D4 — BS/Del on the empty formula: silent no-op (S-078).
//  D5 — BS at an outside station immediately before/after a fenceless 2D
//        structure (fraction, power, root, subscript — S-072, S-109) returns
//        a HIGHLIGHT DECISION: no op, nothing logged (U2 — the highlight is
//        transient controller/UI state); the confirming BS (the armed target
//        passed back through opts) deletes the structure WITH its content.
//        It never fires from inside a slot: there BS is char-wise / D6.
//  D6 — BS at a □ of a fenceless structure UNWRAPS and PROMOTES (S-073,
//        S-100–S-102): the structure goes, the surviving sibling splices
//        inline at its position, caret at the deleted slot's side of the
//        promoted content; both slots empty → the structure dies outright.
//        A subscript whose script label is empty dies with the base surviving
//        as an ordinary symbol (S-102).
//  D7 — functions: the movable `)` deletes first (close → false), then the
//        chain runs char-wise inward; an emptied argument is the □ and BS
//        there deletes the ENTIRE function (S-075, the S-023 anchor); BS at
//        the argument start deletes the entire ATOMIC head `sin(` — content
//        and closing paren survive as a glyph-less pair carrying the close as
//        a fence token (S-077). The one caret where both rules meet — the
//        argument start with an EMPTY argument — takes the □ reading (S-023
//        A, "the empty-arg chain is explicitly unchanged"); the head swap
//        needs argument content to survive (the ruled example carries `a+b`).
//  D8 — groups delete letter-wise: the movable close paren first, the
//        content char-wise (S-076); at the content start the OPEN fence
//        deletes ("letter by letter deletion, including the opening parens")
//        — the content promotes and the surviving close becomes a fence
//        token.
//  D9 — an emptied group shows □ and BS there deletes the WHOLE group — both
//        fences in one stroke (S-079 A, S-103); the group and function chains
//        converge at the empty point.
//
// One key = exactly ONE mechanical op = one log entry (U2: the D6 unwrap, the
// D7 head delete, the D9 whole-group death are single place/deleteAt ops);
// the D5 highlight applies nothing. Every decision is pure and every produced
// state passes the fromJSON gate by construction (the reducer rebuilds
// through it).
//
// Unruled defaults (checked against docs/context/interaction.md — the ruled
// text covers the cases above; everything else is the D4 rejection pattern):
//  - Ctrl+BS at a left-adjacent STRUCTURE/fenced container/fence: the D5
//    highlight chain (not a whole delete) — the structure-confirm stays
//    two-step.
//  - forward Delete at a □ slot / facing structures/fenced containers/nested
//    rows / at dangling glyphs / at pending cells: silent no-op.
//  - a `0.|` whose 0 deletes empties the in-progress number (a bare dot is
//    unrepresentable) — the whole num node goes.
//  - a sub's cross-label boundaries: BS at the script's offset 0 with script
//    content is a silent no-op (labels are separate text channels).

import type { Envelope, NodeJson } from '../ast/json.js';

import {
  caretResolvesIn,
  isRowNode,
  nodeAt,
  refOfPath,
  rowArgs,
  slotsOf,
  slotValue,
  subLabelText,
  tokenText,
  type Caret,
  type Path,
  type Ref,
  type SlotName,
  type SubLabel,
} from './caret.js';

import { EngineError } from './errors.js';

import { entryStation } from './nav.js';

import { applyOp, envelopeOf, type EditingState, type Op, type Position } from './ops.js';

import { defaultStaticVocabulary } from '../ast/vocabulary.js';

import {
  fnJson,
  groupJson,
  implicitPair,
  numFromText,
  rowClone,
} from './policy.js';

// ——— the decision types ———

export interface BackspaceOpts {
  /** Ctrl held: the D3 split semantics. */
  readonly ctrl?: boolean;
  /** The armed D5 highlight target (the confirming BS deletes it with content). */
  readonly highlighted?: Path | null;
  /** The session's unit names for the S-104 label re-validation; the
   *  `backspace` wrapper derives this from the state. */
  readonly units?: ReadonlySet<string>;
}

export type BackspaceKind =
  | 'noop' // D4 / region starts / unruled rejections — nothing applied, nothing logged
  | 'char' // D1/D2: one character leaves a token (dot/unit/sub interplays included)
  | 'token-death' // D1: an emptied token leaves its position (an args cell → the pending null)
  | 'glyph' // D2/S-066 A: a dangling operator glyph goes (pending-cell splice / row unwrap)
  | 'open-fence' // D7b/S-076: an open fence goes (the atomic head / a group's open paren)
  | 'close-fence' // D7/D8: the movable `)` goes (close → false), the chain continues inside
  | 'container-death' // D7a/D9: an empty-point BS deletes the whole fn/group/container
  | 'unwrap' // D6: the □-slot unwrap with the surviving sibling promoted inline
  | 'highlight' // D5: transient highlight arm (nothing applies, nothing logs)
  | 'delete-structure'; // D5 confirm: the highlighted structure deletes WITH its content

export interface BackspaceDecision {
  readonly kind: BackspaceKind;
  /** Zero ops: noop or the first-press highlight. Otherwise exactly one
   *  mechanical op (U2 — one key, one log entry). */
  readonly ops: readonly Op[];
  /** The caret after the op applies (the unchanged caret on highlight/noop). */
  readonly caret: Caret;
  /** The D5 target structure's path (present on highlight + delete-structure). */
  readonly target?: Path;
}

interface BsCtx {
  readonly ctrl: boolean;
  readonly highlighted?: Path | null;
  readonly units: ReadonlySet<string>;
}

const noopDecision = (caret: Caret): BackspaceDecision => ({ kind: 'noop', ops: [], caret });

// ——— positions / refs / freed spots ———

const posOfRef = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'root' };
    case 'slot':
      return { at: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'row', path: ref.path, index: ref.index };
  }
};

const replacePosOfRef = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'replaceRoot' };
    case 'slot':
      return { at: 'replaceSlot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'replaceCell', path: ref.path, index: ref.index };
  }
};

const pathOfRef = (ref: Ref): Path =>
  ref.at === 'root' ? [] : ref.at === 'slot' ? [...ref.path, ref.slot] : [...ref.path, ref.index];

/** The freed spot a removal leaves behind: root → the empty formula, a fixed
 *  slot → its □ caret, an args cell → the row station at the position. */
const freedSpot = (ref: Ref): Caret => {
  switch (ref.at) {
    case 'root':
      return { kind: 'empty' };
    case 'slot':
      return { kind: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { kind: 'row', path: ref.path, index: ref.index };
  }
};

// ——— JSON furniture ———

const clone = (env: Envelope): Envelope => JSON.parse(JSON.stringify(env)) as Envelope;

/** A working copy of `env` with `ref`'s content replaced — the tree the
 *  decision's own place/deleteAt op produces (for entry-station lookups). */
function withRefSet(env: Envelope, ref: Ref, node: NodeJson | null): Envelope {
  const after = clone(env);
  if (ref.at === 'root') after.root = node;
  else if (ref.at === 'slot') {
    const owner = nodeAt(after, ref.path) as NodeJson;
    (owner as unknown as Record<string, unknown>)[ref.slot] = node;
  } else {
    rowArgs(nodeAt(after, ref.path) as NodeJson)[ref.index] = node;
  }
  return after;
}

const rowIsImplicit = (node: NodeJson): boolean =>
  node.type === 'op' && (node as { implicit?: boolean }).implicit === true;

const fenceToken: NodeJson = { type: 'fence', side: 'close' };

const symOf = (name: string): NodeJson => ({ type: 'sym', name }) as NodeJson;

const unitOf = (value: NodeJson | null, unit: string): NodeJson => ({ type: 'unit', value, unit }) as NodeJson;

const dfltUnits = (): ReadonlySet<string> => new Set(defaultStaticVocabulary.units);

const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/** A fenceless 2D structure for D5: fraction, power (the node and the ≤2-arg
 *  op row alike), root, subscript (S-072, S-109). */
const isD5Structure = (node: NodeJson): boolean =>
  node.type === 'frac' ||
  node.type === 'pow' ||
  node.type === 'root' ||
  node.type === 'sub' ||
  (node.type === 'op' && (node as { op: string }).op === 'pow' && (rowArgs(node) as unknown[]).length <= 2);

/** The close state of a fenced container (group/fn): false = the movable
 *  close fence is already gone (the open-ended chain continues inward). */
const isClosed = (node: NodeJson): boolean =>
  (node.type !== 'group' && node.type !== 'fn') || (node as { close?: boolean }).close !== false;

/** The D6 landing station: after a promotion the caret sits at the side of
 *  the promoted content that the deleted slot faced — the row seam
 *  before/after the promoted cell, the entry station from that side at
 *  root/slot refs. */
function spliceStation(after: Envelope, ref: Ref, facing: 'left' | 'right'): Caret {
  const contentPath = pathOfRef(ref);
  if (ref.at === 'cell') {
    return { kind: 'row', path: ref.path, index: facing === 'left' ? ref.index : ref.index + 1 };
  }
  return entryStation(after, contentPath, facing) ?? { kind: 'node', path: contentPath };
}

// ——— the D5 gate ———

/** The D5 decision for a fenceless structure at `target`: the armed target
 *  (passed back through opts) confirms the deletion WITH content; any other
 *  press arms the highlight. Nothing logs on the highlight (U2). */
function d5Gate(target: Path, station: Caret, ctx: BsCtx): BackspaceDecision {
  if (ctx.highlighted !== undefined && ctx.highlighted !== null && samePath(ctx.highlighted, target)) {
    const ref = refOfPath(target);
    return { kind: 'delete-structure', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref), target };
  }
  return { kind: 'highlight', ops: [], caret: station, target };
}

// ——— D1 token surgery ———

/** D1: a deletion that empties a token removes the NODE — at an args cell the
 *  cell becomes the PENDING NULL (the glyph survives as dangling; the D2 rule
 *  deletes it next), at a fixed slot the □, at the root the empty formula. */
function tokenDeath(env: Envelope, path: Path, station: Caret): BackspaceDecision {
  const ref = refOfPath(path);
  if (ref.at !== 'cell') {
    return { kind: 'token-death', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
  }
  const row = nodeAt(env, ref.path) as NodeJson;
  const cells = rowArgs(row).map((c, i) => (i === ref.index ? null : c));
  const freed: Caret = { kind: 'row', path: ref.path, index: ref.index };
  return { kind: 'token-death', ops: [{ op: 'place', node: rowClone(row, cells), at: replacePosOfRef(refOfPath(ref.path)), to: freed }], caret: freed };
}

/** One character leaves a num/sym/unit token at `drop`; the shortened
 *  replacement places in situ — the dot flag regenerates from the text
 *  (deleting the trailing dot clears it), the unit label re-validates per
 *  S-104: a still-known run stays attached, an unknown non-empty run reverts
 *  to the [value, symbol] pair (caret in the run), an empty run keeps the
 *  incomplete unit. An empty/unrepresentable remainder is the token death. */
function charDrop(env: Envelope, node: NodeJson, path: Path, drop: number, to: Caret, ctx: BsCtx): BackspaceDecision {
  const ref = refOfPath(path);
  if (node.type === 'num' || node.type === 'sym') {
    const text = tokenText(node);
    const next = text.slice(0, drop) + text.slice(drop + 1);
    if (next === '') return tokenDeath(env, path, to);
    const replacement = node.type === 'sym' ? symOf(next) : numFromText(next);
    if (replacement === null) return tokenDeath(env, path, to); // a bare `.` is unrepresentable
    return { kind: 'char', ops: [{ op: 'place', node: replacement, at: replacePosOfRef(ref), to }], caret: to };
  }
  if (node.type === 'unit') {
    const value = (node as { value: NodeJson | null }).value;
    const text = tokenText(node);
    const next = text.slice(0, drop) + text.slice(drop + 1);
    if (next === '' || ctx.units.has(next)) {
      return { kind: 'char', ops: [{ op: 'place', node: unitOf(value, next), at: replacePosOfRef(ref), to }], caret: to };
    }
    const runPath = [...pathOfRef(ref), 1];
    const runTo: Caret = { kind: 'token', path: runPath, index: drop };
    return { kind: 'char', ops: [{ op: 'place', node: implicitPair(value, symOf(next)), at: replacePosOfRef(ref), to: runTo }], caret: runTo };
  }
  return noopDecision(to);
}

/** D3 in-token: everything left of the caret goes (text[index..) survives,
 *  the caret at offset 0); empty/unrepresentable remains are the token death. */
function ctrlLeftRun(env: Envelope, node: NodeJson, path: Path, index: number, ctx: BsCtx): BackspaceDecision {
  const ref = refOfPath(path);
  const to: Caret = { kind: 'token', path, index: 0 };
  if (node.type === 'sym' || node.type === 'num') {
    const rest = tokenText(node).slice(index);
    if (rest === '' || (node.type === 'num' && numFromText(rest) === null)) {
      return tokenDeath(env, path, to);
    }
    const replacement = node.type === 'sym' ? symOf(rest) : (numFromText(rest) as NodeJson);
    return { kind: 'char', ops: [{ op: 'place', node: replacement, at: replacePosOfRef(ref), to }], caret: to };
  }
  if (node.type === 'unit') {
    const value = (node as { value: NodeJson | null }).value;
    const rest = tokenText(node).slice(index);
    if (rest === '' || ctx.units.has(rest)) {
      return { kind: 'char', ops: [{ op: 'place', node: unitOf(value, rest), at: replacePosOfRef(ref), to }], caret: to };
    }
    const runPath = [...pathOfRef(ref), 1];
    const runTo: Caret = { kind: 'token', path: runPath, index: 0 };
    return { kind: 'char', ops: [{ op: 'place', node: implicitPair(value, symOf(rest)), at: replacePosOfRef(ref), to: runTo }], caret: runTo };
  }
  return tokenDeath(env, path, to); // ctrl at a non-text token: the D4 pattern
}

// ——— sub labels (T9) ———

const SUB_BASE_SHAPE = /^\p{L}[\p{L}\p{N}]*$/u;

function subLabelChar(env: Envelope, node: NodeJson, path: Path, label: SubLabel, index: number, ctx: BsCtx): BackspaceDecision {
  const labels = node as { base: string; sub: string };
  const text = subLabelText(node, label);
  const drop = index - 1;
  const next = text.slice(0, drop) + text.slice(drop + 1);
  const ref = refOfPath(path);
  if (label === 'base' && !SUB_BASE_SHAPE.test(next)) {
    return noopDecision({ kind: 'token', path, index, label }); // a shape-breaking shrink: silent no-op
  }
  const to: Caret = { kind: 'token', path, index: drop, label };
  const grown = label === 'base' ? ({ type: 'sub', base: next, sub: labels.sub } as NodeJson) : ({ type: 'sub', base: labels.base, sub: next } as NodeJson);
  return { kind: 'char', ops: [{ op: 'place', node: grown, at: replacePosOfRef(ref), to }], caret: to };
}

/** The sub's empty-script death (S-102): the sub goes, the base survives as
 *  an ordinary symbol at the structure's position, caret at the promoted
 *  side. Both labels empty → outright death (nothing promotes). */
function subScriptUnwrap(env: Envelope, path: Path, node: NodeJson): BackspaceDecision {
  const base = (node as { base: string; sub: string }).base;
  const ref = refOfPath(path);
  if (base === '') {
    return { kind: 'unwrap', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
  }
  const promoted = symOf(base);
  const after = withRefSet(env, ref, promoted);
  const to = spliceStation(after, ref, 'right'); // the script faced the right of the base
  return { kind: 'unwrap', ops: [{ op: 'place', node: promoted, at: replacePosOfRef(ref), to }], caret: to };
}

/** BS at a sub label's offset 0: the empty-script □ unwraps (S-102); the base
 *  label's left edge is the sub's before-station (D5 from a parent row);
 *  cross-label boundaries are silent no-ops (unruled). */
function subLabelAtStart(env: Envelope, node: NodeJson, path: Path, label: SubLabel, ctx: BsCtx): BackspaceDecision {
  const labels = node as { base: string; sub: string };
  if (label === 'sub' && labels.sub === '') return subScriptUnwrap(env, path, node);
  if (label === 'base' && labels.base === '') {
    // A baseless sub cannot keep content (the script is a modifier channel):
    // the structure dies, nothing promoted (the empty-template both-empty
    // case included).
    const ref = refOfPath(path);
    return { kind: 'unwrap', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
  }
  if (label === 'base') {
    // The sub's visual left edge: the before-station rules of its container.
    const ref = refOfPath(path);
    return ref.at === 'cell'
      ? rowSeam(env, ref.path, ref.index, { kind: 'node', path }, ctx)
      : noopDecision({ kind: 'node', path });
  }
  return noopDecision({ kind: 'token', path, index: 0, label }); // cross-label: unruled
}

// ——— fenced containers (D7/D8) ———

/** BS at a station whose left-adjacent element is the group/fn at `path`:
 *  the movable `)` deletes first (close → false, the chain continues at the
 *  content's right edge), or — already open-ended — the chain descends into
 *  the content; the empty point takes the whole container (D7a/D9). */
function fencedTail(env: Envelope, path: Path, node: NodeJson, station: Caret, ctx: BsCtx): BackspaceDecision {
  const ref = refOfPath(path);
  const args = node.type === 'fn' ? rowArgs(node) : null;
  if (isClosed(node)) {
    const rebuilt =
      node.type === 'group'
        ? groupJson((node as { child: NodeJson | null }).child, false)
        : fnJson((node as { name: string }).name, rowArgs(node), false);
    const after = withRefSet(env, ref, rebuilt);
    const contentPath: Path =
      node.type === 'group' ? [...path, 'child'] : [...path, Math.max((args as (NodeJson | null)[]).length - 1, 0)];
    const fallback: Caret =
      node.type === 'group'
        ? { kind: 'slot', path, slot: 'child' }
        : { kind: 'row', path, index: Math.max((args as (NodeJson | null)[]).length - 1, 0) };
    const to = entryStation(after, contentPath, 'right') ?? fallback;
    return { kind: 'close-fence', ops: [{ op: 'place', node: rebuilt, at: replacePosOfRef(ref), to }], caret: to };
  }
  if (node.type === 'group') {
    const child = (node as { child: NodeJson | null }).child;
    return child === null ? containerDeath(path, station) : tail(env, [...path, 'child'], station, ctx);
  }
  const rowArgs_ = args as (NodeJson | null)[];
  if (rowArgs_.length === 0 || rowArgs_[rowArgs_.length - 1] === null) {
    // The emptied argument is the □ (S-023 A): BS deletes the ENTIRE function.
    return containerDeath(path, station);
  }
  return tail(env, [...path, rowArgs_.length - 1], station, ctx);
}

function containerDeath(path: Path, station: Caret): BackspaceDecision {
  const ref = refOfPath(path);
  return { kind: 'container-death', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
}

// ——— D2 glyph / open fence / head ———

/** D2/S-066 A: a dangling operator glyph deletes — its pending cell splices
 *  away; a one-cell remainder unwraps into that cell (caret at the promoted
 *  content's right side); nothing left kills the row. One op. */
function glyphSplice(env: Envelope, rowPath: Path, nullIndex: number, station: Caret): BackspaceDecision {
  const row = nodeAt(env, rowPath) as NodeJson;
  const args = rowArgs(row);
  const ref = refOfPath(rowPath);
  const cells = args.filter((_, i) => i !== nullIndex);
  if (cells.length === 0 || (cells.length === 1 && cells[0] === null)) {
    // Nothing visible remains (the fresh glyph template, an all-null row):
    // the row dies with its glyph.
    return { kind: 'glyph', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
  }
  if (cells.length === 1 && cells[0] !== null) {
    const after = withRefSet(env, ref, cells[0]);
    const to = spliceStation(after, ref, 'right');
    return { kind: 'glyph', ops: [{ op: 'place', node: cells[0], at: replacePosOfRef(ref), to }], caret: to };
  }
  const to: Caret = { kind: 'row', path: rowPath, index: Math.min(nullIndex, cells.length) };
  return { kind: 'glyph', ops: [{ op: 'place', node: rowClone(row, cells), at: replacePosOfRef(ref), to }], caret: to };
}

/** The landing station after an open-fence/head delete: content + close-fence
 *  promote as an implicit pair (caret at the pair's start seam — the open
 *  fence's former position); a lone content payload (close already gone)
 *  keeps the same visual position (the seam before the promoted cell, the
 *  content's left entry at root/slot). */
function payloadStartStation(after: Envelope, ref: Ref, payload: NodeJson): Caret {
  const pair = payload.type === 'op' && (payload as { implicit?: boolean }).implicit === true;
  if (!pair) {
    if (ref.at === 'cell') return { kind: 'row', path: ref.path, index: ref.index };
    const contentPath = pathOfRef(ref);
    return entryStation(after, contentPath, 'left') ?? { kind: 'node', path: contentPath };
  }
  return { kind: 'row', path: pathOfRef(ref), index: 0 };
}

/** D7b (S-077): BS at the argument start deletes the entire ATOMIC head —
 *  content and closing paren survive: the args promote as glyph-less content
 *  and the close (if present) as a fence token after it, caret at the pair's
 *  start seam. */
function headDelete(env: Envelope, fnPath: Path, fn: NodeJson, station: Caret): BackspaceDecision {
  const args = rowArgs(fn);
  const ref = refOfPath(fnPath);
  const content =
    args.length === 1
      ? args[0]
      : args.length > 1
        ? ({ type: 'op', op: 'multiply', args: [...args], implicit: true } as NodeJson)
        : null;
  const close = isClosed(fn);
  if (content === null) {
    // No argument content stands: the head goes and only the close fence
    // token survives (nothing at close:false).
    if (!close) return containerDeath(fnPath, station);
    const to = freedSpot(ref);
    return { kind: 'open-fence', ops: [{ op: 'place', node: fenceToken, at: replacePosOfRef(ref), to }], caret: to };
  }
  const payload = close ? implicitPair(content, fenceToken) : (content as NodeJson);
  const after = withRefSet(env, ref, payload);
  const to = payloadStartStation(after, ref, payload);
  return { kind: 'open-fence', ops: [{ op: 'place', node: payload, at: replacePosOfRef(ref), to }], caret: to };
}

/** D8 (S-076): BS at a group's content start deletes the OPEN fence — the
 *  content promotes and the surviving close becomes a fence token. At the
 *  empty child the D9 whole-group death wins ("both fences in one stroke"). */
function openFenceDelete(env: Envelope, groupPath: Path, group: NodeJson, station: Caret): BackspaceDecision {
  const child = (group as { child: NodeJson | null }).child;
  const ref = refOfPath(groupPath);
  if (child === null) return containerDeath(groupPath, station);
  const payload = isClosed(group) ? implicitPair(child, fenceToken) : (child as NodeJson);
  const after = withRefSet(env, ref, payload);
  const to = payloadStartStation(after, ref, payload);
  return { kind: 'open-fence', ops: [{ op: 'place', node: payload, at: replacePosOfRef(ref), to }], caret: to };
}

// ——— the tail dispatch ———

/** The node at `path` is the left-adjacent VISUAL element of the BS station:
 *  dispatch by class — token surgery (D1), D5 for fenceless structures, the
 *  D7/D8 close-fence flip for closed containers (descending when
 *  open-ended), whole-fence deletion, and args-row edge transparency (the
 *  nested dangling glyph included). */
function tail(env: Envelope, path: Path, station: Caret, ctx: BsCtx): BackspaceDecision {
  const node = nodeAt(env, path) as NodeJson | null;
  if (node === null) return noopDecision(station);
  switch (node.type) {
    case 'num':
    case 'sym':
    case 'unit': {
      if (node.type === 'unit' && tokenText(node) === '') {
        // An empty granular label: the visible tail is the value.
        const value = (node as { value: NodeJson | null }).value;
        if (value === null) return containerDeath(path, station);
        return tail(env, [...path, 'value'], station, ctx);
      }
      if (tokenText(node) === '') return noopDecision(station); // nothing visible to take
      if (ctx.ctrl) return tokenDeath(env, path, station); // D3 word-delete at a gap
      return charDrop(env, node, path, tokenText(node).length - 1, station, ctx);
    }
    case 'sub':
    case 'frac':
    case 'pow':
    case 'root':
      return d5Gate(path, station, ctx);
    case 'op': {
      if ((node as { op: string }).op === 'pow') return d5Gate(path, station, ctx);
      const args = rowArgs(node);
      if (!rowIsImplicit(node) && args.length > 0 && args[args.length - 1] === null) {
        return glyphSplice(env, path, args.length - 1, station); // the nested dangling glyph
      }
      let idx = args.length - 1;
      while (idx >= 0 && args[idx] === null) idx -= 1; // invisible nulls render nothing
      if (idx < 0) return noopDecision(station);
      return tail(env, [...path, idx], station, ctx);
    }
    case 'group':
    case 'fn':
      return fencedTail(env, path, node, station, ctx);
    case 'fence': {
      const ref = refOfPath(path);
      return { kind: 'token-death', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
    }
    default:
      return noopDecision(station);
  }
}

// ——— row stations (the N2 shared gap) ———

/** BS at args-row station `index` of the op/fn row at `rowPath` (also the
 *  dispatch target of node-on-token / token-at-0 left edges). */
function rowSeam(env: Envelope, rowPath: Path, index: number, station: Caret, ctx: BsCtx): BackspaceDecision {
  const row = nodeAt(env, rowPath) as NodeJson;
  const args = rowArgs(row);
  const fn = row.type === 'fn';
  const atEnd = index >= args.length;

  // D7b: the argument start. With an EMPTY first argument the □ reading wins
  // (S-023 A — "the empty-arg chain is explicitly unchanged"); the head swap
  // needs argument content to survive (the ruled example carries `a+b`).
  if (fn && index === 0) {
    return args.length > 0 && args[0] === null ? containerDeath(rowPath, station) : headDelete(env, rowPath, row, station);
  }

  // Dangling-glyph rules (D2/S-066 A): the station's nearest visible left
  // element is an operator glyph pending its operand. Implicit rows render
  // no glyphs; fn arg cells are □-territory (handled above/at the entry).
  if (!fn && !rowIsImplicit(row)) {
    if (index > 0 && index < args.length && args[index] === null) {
      return glyphSplice(env, rowPath, index, station); // a caret inside a pending cell: after its glyph
    }
    if (atEnd && args.length > 0 && args[args.length - 1] === null) {
      return glyphSplice(env, rowPath, args.length - 1, station); // the trailing pending cell
    }
    if (index > 0 && index < args.length && args[index] !== null && args[index - 1] === null) {
      return glyphSplice(env, rowPath, index - 1, station); // a glyph right after a pending cell
    }
  }

  // D5 before-shadow (S-072: "immediately before/after"): a fenceless
  // structure right of the station highlights.
  if (index < args.length && args[index] !== null && isD5Structure(args[index] as NodeJson)) {
    return d5Gate([...rowPath, index], station, ctx);
  }

  // An empty fn argument left of the seam: the argument cell (and its comma) go.
  if (fn && index > 0 && args[index - 1] === null) {
    const cells = args.filter((_, i) => i !== index - 1);
    const to: Caret = { kind: 'row', path: rowPath, index: index - 1 };
    return { kind: 'glyph', ops: [{ op: 'place', node: rowClone(row, cells), at: replacePosOfRef(refOfPath(rowPath)), to }], caret: to };
  }

  if (index === 0) {
    // Row start: nothing stands left — except the content start of a GROUP's
    // inlined child row reaches the group's open fence (D8/S-076).
    const ref = refOfPath(rowPath);
    if (ref.at === 'slot' && ref.slot === 'child') {
      const group = nodeAt(env, ref.path) as NodeJson;
      if (group.type === 'group') return openFenceDelete(env, ref.path, group, station);
    }
    return noopDecision(station); // D4 pattern (region start)
  }
  if (args[index - 1] === undefined || args[index - 1] === null) {
    return noopDecision(station); // an invisible gap with no glyph to its left
  }
  return tail(env, [...rowPath, index - 1], station, ctx);
}

// ——— caret-kind entries ———

function stationLeftOf(env: Envelope, caret: Caret, ctx: BsCtx): BackspaceDecision {
  // The caret sits at a content start with nothing of its own to take.
  const path = (caret as { path?: Path }).path ?? [];
  const ref = refOfPath(path);
  if (ref.at === 'cell') return rowSeam(env, ref.path, ref.index, caret, ctx);
  if (ref.at === 'slot') {
    const parent = nodeAt(env, ref.path) as NodeJson;
    if (parent.type === 'group' && ref.slot === 'child') {
      // D8/S-076: the group's content start — the open fence (or the whole
      // group at the empty child).
      return openFenceDelete(env, ref.path, parent, caret);
    }
  }
  return noopDecision(caret); // D4 pattern (region start)
}

function tokenStation(env: Envelope, caret: Extract<Caret, { kind: 'token' }>, ctx: BsCtx): BackspaceDecision {
  const node = nodeAt(env, caret.path) as NodeJson;
  if (node.type === 'sub') {
    if (caret.label === undefined) return noopDecision(caret);
    if (caret.index > 0) return subLabelChar(env, node, caret.path, caret.label, caret.index, ctx);
    return subLabelAtStart(env, node, caret.path, caret.label, ctx);
  }
  if (caret.index > 0) {
    if (ctx.ctrl) return ctrlLeftRun(env, node, caret.path, caret.index, ctx);
    const to: Caret = { kind: 'token', path: caret.path, index: caret.index - 1 };
    return charDrop(env, node, caret.path, caret.index - 1, to, ctx);
  }
  return stationLeftOf(env, caret, ctx);
}

function nodeStation(env: Envelope, caret: Extract<Caret, { kind: 'node' }>, ctx: BsCtx): BackspaceDecision {
  const node = nodeAt(env, caret.path) as NodeJson;
  const to: Caret = { kind: 'node', path: caret.path };
  switch (node.type) {
    case 'num':
    case 'sym':
    case 'unit': {
      // The node caret on a leaf reads as the token's right edge (D1/D3).
      if (ctx.ctrl) return tokenDeath(env, caret.path, to);
      if (node.type === 'unit' && tokenText(node) === '') {
        const value = (node as { value: NodeJson | null }).value;
        if (value === null) return containerDeath(caret.path, caret);
        return tail(env, [...caret.path, 'value'], caret, ctx);
      }
      if (tokenText(node) === '') return tokenDeath(env, caret.path, to);
      return charDrop(env, node, caret.path, tokenText(node).length - 1, to, ctx);
    }
    case 'fence': {
      const ref = refOfPath(caret.path);
      return { kind: 'token-death', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
    }
    case 'op':
      if ((node as { op: string }).op === 'pow') return d5Gate(caret.path, caret, ctx); // op-pow renders as a 2D power
      return rowSeam(env, caret.path, rowArgs(node).length, caret, ctx);
    case 'group':
    case 'fn':
    case 'sub':
    case 'frac':
    case 'pow':
    case 'root':
      return tail(env, caret.path, caret, ctx);
    default:
      return noopDecision(caret);
  }
}

function slotStation(env: Envelope, caret: Extract<Caret, { kind: 'slot' }>): BackspaceDecision {
  const parent = nodeAt(env, caret.path) as NodeJson;
  switch (parent.type) {
    case 'group':
      // D9 (S-079 A, S-103): BS at `(|□)` deletes the ENTIRE group — both
      // fences in one stroke, regardless of the close state.
      return containerDeath(caret.path, caret);
    case 'unit':
      // A valueless unit has no ruled inner chain: the whole token goes.
      return containerDeath(caret.path, caret);
    case 'frac':
    case 'pow':
    case 'root':
      return unwrap(env, caret.path, parent, caret);
    default:
      return noopDecision(caret); // an unaddressed slot: D4 pattern
  }
}

/** D6/S-073/S-100–S-102: BS at a □ slot of a fenceless structure — the
 *  structure dies and the surviving sibling splices inline at its position,
 *  caret at the deleted slot's side of the promoted content; an empty
 *  sibling means outright death. */
function unwrap(env: Envelope, parentPath: Path, parent: NodeJson, station: Caret): BackspaceDecision {
  if (station.kind !== 'slot') return noopDecision(station);
  const slot = station.slot;
  const flow = slotsOf(parent); // declaration order == the ruled flow order (frac/pow/root)
  const siblingSlot = flow.find((s) => s !== slot) ?? null;
  const sibling = siblingSlot === null ? null : slotValue(parent, siblingSlot);
  const ref = refOfPath(parentPath);
  if (siblingSlot === null || sibling === null) {
    // The sibling slot does not exist or is empty too → outright death,
    // nothing promoted (S-073: "both slots empty → the structure dies").
    return { kind: 'unwrap', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret: freedSpot(ref) };
  }
  const facing = flow.indexOf(slot) < flow.indexOf(siblingSlot) ? 'left' : 'right';
  const after = withRefSet(env, ref, sibling);
  const to = spliceStation(after, ref, facing);
  return { kind: 'unwrap', ops: [{ op: 'place', node: sibling, at: replacePosOfRef(ref), to }], caret: to };
}

function rowStationEntry(env: Envelope, caret: Extract<Caret, { kind: 'row' }>, ctx: BsCtx): BackspaceDecision {
  const row = nodeAt(env, caret.path) as NodeJson | null;
  if (row === null || !isRowNode(row)) return noopDecision(caret);
  const args = rowArgs(row);
  if (row.type === 'fn' && caret.index < args.length && args[caret.index] === null) {
    // D7a (S-075, S-023 A): the □ argument — BS deletes the ENTIRE function.
    return containerDeath(caret.path, caret);
  }
  return rowSeam(env, caret.path, caret.index, caret, ctx);
}

// ——— decideBackspace / backspace ———

/**
 * The pure BS decision at `caret` in `env` (D1–D9): the rule kind, at most one
 * mechanical op, the caret afterward, and the D5 highlight target (kind
 * 'highlight' applies nothing — the controller arms the transient UI state).
 * Throws caret-invalid on an unresolvable caret. `opts.units` gates the S-104
 * label re-validation (the `backspace` wrapper derives it from the session).
 */
export function decideBackspace(env: Envelope, caret: Caret, opts: BackspaceOpts = {}): BackspaceDecision {
  if (!caretResolvesIn(env, caret)) {
    throw new EngineError('caret-invalid', `decideBackspace: caret does not resolve (${JSON.stringify(caret)})`);
  }
  const ctx: BsCtx = { ctrl: opts.ctrl === true, highlighted: opts.highlighted, units: opts.units ?? dfltUnits() };
  switch (caret.kind) {
    case 'empty':
      return noopDecision(caret); // D4 (S-078)
    case 'token':
      return tokenStation(env, caret, ctx);
    case 'node':
      return nodeStation(env, caret, ctx);
    case 'slot':
      return slotStation(env, caret);
    case 'row':
      return rowStationEntry(env, caret, ctx);
  }
}

/** Apply one Backspace to the session: decide + apply the emitted op (the
 *  highlight decision applies nothing — the same state object comes back for
 *  the controller to arm its transient UI state). Pure. */
export function backspace(state: EditingState, opts: BackspaceOpts = {}): EditingState {
  const decision = decideBackspace(envelopeOf(state), state.caret, {
    ...opts,
    units: opts.units ?? new Set(state.vocabulary?.units ?? defaultStaticVocabulary.units),
  });
  let next = state;
  for (const op of decision.ops) next = applyOp(next, op);
  return next;
}

// ——— Forward Delete (the ruled mirrors + the named no-op defaults) ———

export interface DeleteOpts {
  readonly ctrl?: boolean;
  readonly units?: ReadonlySet<string>;
}

export type DeleteKind = 'noop' | 'char' | 'token-death';

export interface DeleteDecision {
  readonly kind: DeleteKind;
  readonly ops: readonly Op[];
  readonly caret: Caret;
}

const delNoop = (caret: Caret): DeleteDecision => ({ kind: 'noop', ops: [], caret });

/** Del's whole-token death: the D3-mirror freeing mechanics (identical to BS). */
function delTokenDeath(env: Envelope, path: Path, caret: Caret): DeleteDecision {
  const decision = tokenDeath(env, path, caret);
  return { kind: 'token-death', ops: decision.ops, caret: decision.caret };
}

/** The D1/D3 forward surgery on a num/sym/unit token: `keep` is the surviving
 *  text (the char at the caret for D1, everything right for D3 within the
 *  token / everything after the first char at gaps). The unit label
 *  re-validates per S-104; empty/unrepresentable remains are the death. */
function forwardText(env: Envelope, node: NodeJson, path: Path, keep: string, to: Caret, ctx: { ctrl: boolean; units: ReadonlySet<string> }): DeleteDecision {
  const ref = refOfPath(path);
  if (node.type === 'unit') {
    const value = (node as { value: NodeJson | null }).value;
    if (keep === '' || ctx.units.has(keep)) {
      return { kind: 'char', ops: [{ op: 'place', node: unitOf(value, keep), at: replacePosOfRef(ref), to }], caret: to };
    }
    const runTo: Caret = { kind: 'token', path: [...pathOfRef(ref), 1], index: 0 };
    return { kind: 'char', ops: [{ op: 'place', node: implicitPair(value, symOf(keep)), at: replacePosOfRef(ref), to: runTo }], caret: runTo };
  }
  if (node.type === 'sym') {
    if (keep === '') return delTokenDeath(env, path, to);
    return { kind: 'char', ops: [{ op: 'place', node: symOf(keep), at: replacePosOfRef(ref), to }], caret: to };
  }
  if (node.type === 'num') {
    if (keep === '') return delTokenDeath(env, path, to);
    const replacement = numFromText(keep);
    return replacement === null
      ? delTokenDeath(env, path, to)
      : { kind: 'char', ops: [{ op: 'place', node: replacement, at: replacePosOfRef(ref), to }], caret: to };
  }
  return delNoop(to);
}

/**
 * The pure forward-Delete decision — the D1/D3 mirrors (D1: the character
 * right of the caret, caret stays put; D3: everything right within the token,
 * the whole right-adjacent TEXT token at a gap) + D4 on the empty formula.
 * UNRULED mirrors are NAMED silent no-ops (the D4 rejection pattern): Del at
 * a □ slot, Del facing a fenceless structure / fenced container / nested
 * row, Del at dangling glyphs and pending cells, Del past the rightmost
 * right-adjacent token. A dangling close fence node still dies whole (it is
 * a movable glyph token, C4).
 */
export function decideDelete(env: Envelope, caret: Caret, opts: DeleteOpts = {}): DeleteDecision {
  if (!caretResolvesIn(env, caret)) {
    throw new EngineError('caret-invalid', `decideDelete: caret does not resolve (${JSON.stringify(caret)})`);
  }
  const ctx = { ctrl: opts.ctrl === true, units: opts.units ?? dfltUnits() };
  switch (caret.kind) {
    case 'empty':
      return delNoop(caret); // D4 (S-078)
    case 'token': {
      const node = nodeAt(env, caret.path) as NodeJson;
      if (node.type === 'sub') {
        if (caret.label === undefined || caret.index >= subLabelText(node, caret.label).length) return delNoop(caret);
        const labels = node as { base: string; sub: string };
        const text = subLabelText(node, caret.label);
        const next = text.slice(0, caret.index) + text.slice(caret.index + 1);
        if (caret.label === 'base' && !SUB_BASE_SHAPE.test(next)) return delNoop(caret);
        const grown =
          caret.label === 'base'
            ? ({ type: 'sub', base: next, sub: labels.sub } as NodeJson)
            : ({ type: 'sub', base: labels.base, sub: next } as NodeJson);
        return { kind: 'char', ops: [{ op: 'place', node: grown, at: replacePosOfRef(refOfPath(caret.path)), to: caret }], caret };
      }
      const text = tokenText(node);
      if (caret.index < text.length) {
        const keep = ctx.ctrl ? text.slice(0, caret.index) : text.slice(0, caret.index) + text.slice(caret.index + 1);
        return forwardText(env, node, caret.path, keep, caret, ctx);
      }
      return forwardGap(env, caret, ctx); // the token's right edge: the gap right of it
    }
    case 'node':
      // node-on-token = the right edge; anything larger is the after-station:
      // in both cases the forward action starts past the node.
      return forwardGap(env, caret, ctx);
    case 'slot':
      return delNoop(caret); // Del at a □ inside a structure: unruled (D4 pattern)
    case 'row': {
      const row = nodeAt(env, caret.path) as NodeJson;
      const args = rowArgs(row);
      if (caret.index >= args.length || args[caret.index] === null) return delNoop(caret);
      const target = args[caret.index] as NodeJson;
      if (isD5Structure(target) || isRowNode(target) || target.type === 'group' || target.type === 'fn') {
        return delNoop(caret); // structures/rows/containers right-adjacent: unruled
      }
      if (target.type === 'fence') {
        const ref = refOfPath([...caret.path, caret.index]);
        return { kind: 'token-death', ops: [{ op: 'deleteAt', at: posOfRef(ref) }], caret };
      }
      if (!isTokenNodeLeft(target)) return delNoop(caret);
      const keep = ctx.ctrl ? '' : tokenText(target).slice(1);
      if (ctx.ctrl) return delTokenDeath(env, [...caret.path, caret.index], caret);
      return forwardText(env, target, [...caret.path, caret.index], keep, caret, ctx);
    }
  }
}

const isTokenNodeLeft = (node: NodeJson): boolean =>
  node.type === 'sym' || node.type === 'num' || node.type === 'unit';

/** The forward gap right of the caret's own node: the next right-adjacent
 *  args cell — its first character (D1 mirror) / the whole token (D3). */
function forwardGap(env: Envelope, caret: Caret, ctx: { ctrl: boolean; units: ReadonlySet<string> }): DeleteDecision {
  if (caret.kind === 'empty') return delNoop(caret);
  const path = caret.path as Path;
  const ref = refOfPath(path);
  if (ref.at !== 'cell') return delNoop(caret); // root/slot content ends past the tree edge — N3-mirror
  const row = nodeAt(env, ref.path) as NodeJson;
  const args = rowArgs(row);
  const next = ref.index + 1;
  if (next >= args.length || args[next] === null) {
    return delNoop(caret); // a pending cell / row end — the forward glyph mirror is unruled (named)
  }
  const target = args[next] as NodeJson;
  if (isD5Structure(target) || isRowNode(target) || target.type === 'group' || target.type === 'fn') {
    return delNoop(caret); // structures/nested rows/containers: unruled mirrors
  }
  if (target.type === 'fence') {
    // A dangling close fence is a movable glyph token (C4): the glyph goes whole.
    const fenceRef = refOfPath([...ref.path, next]);
    return { kind: 'token-death', ops: [{ op: 'deleteAt', at: posOfRef(fenceRef) }], caret };
  }
  if (ctx.ctrl) return delTokenDeath(env, [...ref.path, next], caret);
  return forwardText(env, target, [...ref.path, next], tokenText(target).slice(1), caret, ctx);
}

/** Apply one forward Delete to the session (the ruled mirrors; the no-op
 *  decisions change nothing). Pure. */
export function forwardDelete(state: EditingState, opts: DeleteOpts = {}): EditingState {
  const decision = decideDelete(envelopeOf(state), state.caret, {
    ctrl: opts.ctrl,
    units: opts.units ?? new Set(state.vocabulary?.units ?? defaultStaticVocabulary.units),
  });
  let next = state;
  for (const op of decision.ops) next = applyOp(next, op);
  return next;
}
