// The literal typing surface (rework session 2a) — T1–T6 + the owner
// amendments (digit-glue, juxtaposition pairing, S-098; see
// docs/context/interaction.md). The governing principle: a formula row behaves
// like a text editor — a typed token appears at the caret, nothing
// restructures at edit time, and every resulting state is fromJSON-legal
// (storable + renders); evaluation refusals live in the structural gates,
// never here. One typed token = exactly one mechanical op = one log entry
// (U1 run coalescing is session 5).
//
// Station model: every resolvable caret is one of four typing stations —
// a VOID (operand-expected: empty root, empty fixed slot, null args cell —
// also the natural-continue dive of a node caret on an incomplete container),
// a TOKEN (a num/sym at a text offset; a node caret on a leaf reads as the
// token's right edge), a SEAM (an args-row station, the N2 one-station gap),
// or an AFTER station (directly after a complete non-row node — a caret on a
// complete group/fn/frac keeps typing against it as a whole).
//
// Seam adjacency (N2): a typed character lands directly before the
// right-adjacent cell (the one-station gap around a glyph has no glyph
// between it and that cell); gluing crosses glyphs and commas (a letter
// glues into the right token, a digit joins the left symbol's name), while
// juxtaposition — glyph-less adjacency materialized as an implicit-multiply
// pair — bonds the typed token with the closest glyph-free-adjacent cell:
// number/right-side pairs first where both sides are free, the left partner
// at row ends. Juxtaposition never shares an n-ary row with explicit glyphs
// (owner-confirmed mixed-row definition): pairs materialize as their own
// `implicit` subrows nested in the untouched row.
//
// The Space key arms a boundary flag on the caret (S-021/S-022): the next
// same-type input starts a new node instead of gluing — no visible mark, no
// tree change, no log entry (movement-like state); inside a token it splits
// it (S-098's forced number-number adjacency included, as the S-098 editing
// state: storable, rendered with the seam marker, refused at evaluation
// while it persists).

import type { Envelope, NodeJson } from '../ast/json.js';
import { defaultStaticVocabulary } from '../ast/vocabulary.js';
import {
  caretResolvesIn,
  isTokenNode,
  nodeAt,
  pathOfRef,
  refOfPath,
  rowArgs,
  subLabelText,
  tokenText,
  type Caret,
  type Path,
  type Ref,
  type SlotName,
  type SubLabel,
} from './caret.js';
import { EngineError } from './errors.js';
import { entryStation, exitStation } from './nav.js';
import {
  applyOp,
  envelopeOf,
  firstEmpty,
  type EditingState,
  type Op,
  type Position,
} from './ops.js';

/** Row-kind operator glyphs the typing surface inserts literally (T1).
 *  Divide and pow are structure tokens (frac/pow), not row ops. */
export type OperatorFn = 'add' | 'subtract' | 'multiply';

/** Structure-making and special typed tokens. Leaves are separate: a leaf
 *  typed into a VOID fills it mechanically; at TOKEN/SEAM stations the
 *  text rules here handle them. */
export type StructureToken =
  | { readonly t: 'operator'; readonly fn: OperatorFn }
  | { readonly t: 'divide' }
  | { readonly t: 'pow' }
  | { readonly t: 'groupOpen' }
  | { readonly t: 'groupClose' }
  | { readonly t: 'comma' }
  | { readonly t: 'dot' }
  | { readonly t: 'space' };

/** One typed item: a structure token or a leaf value. Leaves are single
 *  characters in practice (the keymap sends one char per key): a leaf num
 *  types as its digits, a leaf sym as its name text. */
export type TypedToken = StructureToken | { readonly t: 'leaf'; readonly node: NodeJson };

// ——— Node JSON helpers (fromJSON gates every produced tree) ———

const rowImplicit = (node: NodeJson): boolean =>
  node.type === 'op' && (node as { implicit?: boolean }).implicit === true;

/** A head-less re-bind pair (D7's own retyping surface, S-077/S-086): an
 *  implicit juxtaposition row whose LAST cell is a dangling close-fence
 *  token — the surviving payload of a head/open-fence delete. Its cells
 *  are waiting for the re-typed `name(`: letters SEED the head symbol as a
 *  fresh leading cell (the head-swap workflow, the owner's B-22 live
 *  check), and `(` then re-heads the content over the waiting fence. */
const rebindTail = (row: NodeJson): boolean => {
  if (!rowImplicit(row)) return false;
  const args = rowArgs(row);
  return args.length >= 2 && args[args.length - 1] !== null &&
    (args[args.length - 1] as { type?: string }).type === 'fence';
};

export const fnJson = (name: string, args: (NodeJson | null)[], close: boolean): NodeJson =>
  close ? { type: 'fn', name, args } : { type: 'fn', name, args, close: false };

export const groupJson = (child: NodeJson | null, close: boolean): NodeJson =>
  ({ type: 'group', parens: 'always', child, ...(close ? {} : { close: false }) }) as NodeJson;

/** The glyph-less juxtaposition pair: its own implicit-multiply subrow. */
export const implicitPair = (a: NodeJson | null, b: NodeJson | null): NodeJson =>
  ({ type: 'op', op: 'multiply', args: [a, b], implicit: true }) as NodeJson;

/** A num from literal text (digits + one dot; a trailing dot is the
 *  in-progress `dot` state, T4). Null when unrepresentable. */
export const numFromText = (text: string): NodeJson | null => {
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return text.endsWith('.') ? ({ type: 'num', value, dot: true } as NodeJson) : ({ type: 'num', value } as NodeJson);
};

const symFromText = (name: string): NodeJson => ({ type: 'sym', name }) as NodeJson;

const unitJson = (value: NodeJson, unit: string): NodeJson => ({ type: 'unit', value, unit }) as NodeJson;

const subJson = (base: string, sub: string): NodeJson => ({ type: 'sub', base, sub }) as NodeJson;

/** The session's unit name set (S-051: the vocabulary the conversion and
 *  fromJSON both gate against — the session's own list, never the default
 *  when a custom vocabulary was opened with). */
export const unitSetOf = (state: EditingState): ReadonlySet<string> =>
  new Set(state.vocabulary?.units ?? defaultStaticVocabulary.units);

/** ——— Sub labels (T9 vocabulary ruling, 2026-11-09) ———
 *  A sub node's label strings glue letters/digits exactly like symbol
 *  names, but the grown label must keep its contracted identifier shape —
 *  fromJSON rejects anything else. A glue that breaks the shape is a silent
 *  no-op. */
const SUB_BASE_SHAPE = /^\p{L}[\p{L}\p{N}]*$/u;
const SUB_SUB_SHAPE = /^[\p{L}\p{N}]+$/u;
const subLabelShapeOk = (label: SubLabel, grown: string): boolean =>
  label === 'base' ? SUB_BASE_SHAPE.test(grown) : SUB_SUB_SHAPE.test(grown);

/** ——— Unit label runs (S-104) ———
 *  Attached units are granular: the label is a letter run addressed by
 *  in-token carets. Typing letters/digits into the label EXTENDS the run —
 *  unit-ness re-validates at the edit (fromJSON gates unit labels, so the
 *  knot cannot survive an unknown label): a still-known label stays an
 *  attached unit; an unknown label reverts to the ordinary symbol pair
 *  (the derived reversion — the value juxtaposed with the grown run,
 *  a fresh pair that REPLACES the unit, so its symbol lives one level
 *  deeper: `toReverted` addresses it). */
function unitGrow(
  ctx: Ctx,
  target: { readonly node: NodeJson | null; readonly path: Path },
  grown: string,
  toKept: Caret,
  toReverted: Caret,
): EditingState {
  const value = (target.node as { value: NodeJson | null }).value;
  if (value === null) return ctx.state;
  const at = replacePosOf(refOfPath(target.path));
  if (unitSetOf(ctx.state).has(grown)) {
    return place(ctx, unitJson(value, grown), at, toKept);
  }
  return place(ctx, implicitPair(value, symFromText(grown)), at, toReverted);
}

/** An op row (n-ary, so same-op glyphs render between the cells). */
const opRow = (fn: OperatorFn, args: (NodeJson | null)[]): NodeJson =>
  ({ type: 'op', op: fn, args }) as NodeJson;

/** Clone an op/fn row with new cells, preserving name/implicit/close. */
export function rowClone(kind: NodeJson, cells: readonly (NodeJson | null)[]): NodeJson {
  if (kind.type === 'fn') {
    return fnJson((kind as { name: string }).name, [...cells], (kind as { close?: boolean }).close !== false);
  }
  const implicit = rowImplicit(kind);
  return {
    type: 'op',
    op: (kind as { op: string }).op,
    args: [...cells],
    ...(implicit ? { implicit: true } : {}),
  } as NodeJson;
}

// ——— Positions ———

const posOf = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'root' };
    case 'slot':
      return { at: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'fill', path: ref.path, index: ref.index };
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

const pathOf = (ref: Ref): Path => pathOfRef(ref);

// ——— Ancestor walks (caret-path prefixes, deepest first) ———

interface Ancestor {
  readonly node: NodeJson;
  readonly path: Path;
}

function* ancestorsOf(env: Envelope, caret: Caret): Generator<Ancestor> {
  const path = caret.kind === 'empty' ? [] : caret.path;
  for (let len = path.length; len >= 0; len -= 1) {
    const node = len === 0 ? env.root : nodeAt(env, path.slice(0, len));
    if (node !== null) yield { node, path: path.slice(0, len) };
  }
}

/** The innermost unclosed open fence to the caret's left (S-097): the
 *  deepest group/fn ancestor carrying close === false. */
function unclosedOf(env: Envelope, caret: Caret): Ancestor | null {
  for (const anc of ancestorsOf(env, caret)) {
    if ((anc.node.type === 'group' || anc.node.type === 'fn') && (anc.node as { close?: boolean }).close === false) {
      return anc;
    }
  }
  return null;
}

/** The deepest fn ancestor (commas append to ITS args). */
function nearestFnOf(env: Envelope, caret: Caret): Ancestor | null {
  for (const anc of ancestorsOf(env, caret)) {
    if (anc.node.type === 'fn') return anc;
  }
  return null;
}

// ——— Edge descent: op rows are transparent at their flanks ———

/** The visually adjacent content of the node at `path` on the given side:
 *  op rows (explicit or implicit) are transparent at their edges — a row's
 *  last/first cell is what the shared gap actually touches, recursively.
 *  Everything else (leaves, structures, fn rows — fence-bounded) is atomic. */
function edgeCell(
  env: Envelope,
  from: Path,
  side: 'first' | 'last',
): { readonly node: NodeJson | null; readonly path: Path } {
  let path = from;
  for (;;) {
    const node = nodeAt(env, path) as NodeJson | null;
    if (node === null || node.type !== 'op') return { node, path };
    const args = rowArgs(node);
    if (args.length === 0) return { node: null, path };
    const idx = side === 'last' ? args.length - 1 : 0;
    if (args[idx] === null) return { node: null, path };
    path = [...path, idx];
  }
}

// ——— Stations ———

interface TokenStation {
  readonly kind: 'tok';
  readonly node: NodeJson;
  readonly ref: Ref;
  readonly path: Path;
  readonly offset: number;
  /** Which sub label string the caret addresses (T9; present exactly on
   *  sub nodes — the station's text is then that label). */
  readonly label?: SubLabel;
}

interface SeamStation {
  readonly kind: 'seam';
  readonly row: NodeJson;
  readonly path: Path;
  readonly index: number;
  readonly args: readonly (NodeJson | null)[];
}

interface AfterStation {
  readonly kind: 'after';
  readonly node: NodeJson;
  readonly ref: Ref;
  readonly path: Path;
  /** 4b-1 OA-flank-stations: typing at the LEFT flank pairs the fresh
   *  token directly BEFORE the structure (inserts a node directly
   *  adjacent); absent/`false` = the ordinary after-station pairing. */
  readonly before?: boolean;
}

interface VoidStation {
  readonly kind: 'void';
  readonly ref: Ref;
  readonly path: Path;
}

type Station = TokenStation | SeamStation | AfterStation | VoidStation;

/** The text a token station addresses: the caret's sub label when the node
 *  is a sub (T9), else the node's own token text. */
const stationText = (station: TokenStation): string =>
  station.label !== undefined ? subLabelText(station.node, station.label) : tokenText(station.node);

function stationOf(env: Envelope, caret: Caret): Station {
  switch (caret.kind) {
    case 'empty':
      return { kind: 'void', ref: { at: 'root' }, path: [] };
    case 'slot':
      return { kind: 'void', ref: { at: 'slot', path: caret.path, slot: caret.slot }, path: caret.path };
    case 'row': {
      const row = nodeAt(env, caret.path) as NodeJson;
      const args = rowArgs(row);
      if (caret.index < args.length && args[caret.index] === null) {
        return { kind: 'void', ref: { at: 'cell', path: caret.path, index: caret.index }, path: caret.path };
      }
      return { kind: 'seam', row, path: caret.path, index: caret.index, args };
    }
    case 'node': {
      const node = nodeAt(env, caret.path) as NodeJson;
      if (caret.side !== undefined) {
        // 4b-1 OA-flank-stations: the flank is a typing station against the
        // structure AS A WHOLE — a typed token pairs directly adjacent
        // (before/after per the side); the void natural-continue never
        // applies through a flank (the side field wins).
        return {
          kind: 'after',
          node,
          ref: refOfPath(caret.path),
          path: caret.path,
          before: caret.side === 'left',
        };
      }
      if (isTokenNode(node)) {
        return { kind: 'tok', node, ref: refOfPath(caret.path), path: caret.path, offset: tokenText(node).length };
      }
      const empty = firstEmpty(node);
      if (empty !== null) {
        // Natural continue (session-3): typing at a container with a
        // pending slot/cell continues inside it.
        return 'slot' in empty
          ? { kind: 'void', ref: { at: 'slot', path: caret.path, slot: empty.slot }, path: caret.path }
          : { kind: 'void', ref: { at: 'cell', path: caret.path, index: empty.index }, path: caret.path };
      }
      if (node.type === 'op' || node.type === 'fn') {
        return { kind: 'seam', row: node, path: caret.path, index: rowArgs(node).length, args: rowArgs(node) };
      }
      return { kind: 'after', node, ref: refOfPath(caret.path), path: caret.path };
    }
    case 'token':
      return {
        kind: 'tok',
        node: nodeAt(env, caret.path) as NodeJson,
        ref: refOfPath(caret.path),
        path: caret.path,
        offset: caret.index,
        ...(caret.label !== undefined ? { label: caret.label } : {}),
      };
  }
}

// ——— Dispatch context and emission helpers ———

interface Ctx {
  readonly env: Envelope;
  readonly state: EditingState;
  readonly caret: Caret;
  readonly flagged: boolean;
}

const armed = (ctx: Ctx): EditingState =>
  ({ ...ctx.state, caret: { ...ctx.caret, boundary: true } as Caret });

const apply1 = (ctx: Ctx, op: Op): EditingState => applyOp(ctx.state, op);

const place = (ctx: Ctx, node: NodeJson | null, at: Position, to: Caret): EditingState =>
  apply1(ctx, { op: 'place', node, at, to });

/** OA-token-end (rework 4a): the in-token end state of a freshly typed
 *  leaf token — typing never leaves a whole-node caret on the fresh token
 *  (the state that painted at the element's left edge). Non-text leaves
 *  keep the node caret. */
function tokenEndCaret(path: Path, node: NodeJson): Caret {
  if (isTokenNode(node)) return { kind: 'token', path, index: tokenText(node).length };
  return { kind: 'node', path };
}

/** The caret for a freshly juxtaposed token: inside a `0.`
 *  number after its dot (S-012/S-033), inside a fresh group's content slot
 *  (T6 — typing continues between the fences), at a fresh subscript's base
 *  label (T9 — the template's first empty string), the fresh fence's pair
 *  seam (the position right after the glyph token), else the IN-TOKEN end
 *  of the inserted token (OA-token-end — never a whole-node caret, and
 *  never the pair's trailing seam, which would duplicate the token end's
 *  visual spot). */
function pairCaret(base: Path, cell: number, newTok: NodeJson): Caret {
  if (newTok.type === 'num' && (newTok as { dot?: boolean }).dot === true) {
    return { kind: 'token', path: [...base, cell], index: 2 };
  }
  if (newTok.type === 'group') {
    return { kind: 'slot', path: [...base, cell], slot: 'child' };
  }
  if (newTok.type === 'sub') {
    return { kind: 'token', path: [...base, cell], index: 0, label: 'base' };
  }
  if (newTok.type === 'fence') {
    return { kind: 'row', path: base, index: cell + 1 };
  }
  return { kind: 'token', path: [...base, cell], index: tokenText(newTok).length };
}

/** The shared before/after flag of the flank stations (4b-1 OA-flank-stations):
 *  true = the LEFT flank pairs a typed token directly BEFORE the structure. */
interface FlankPair {
  readonly before?: boolean;
}

/** Pair the station's node with a freshly typed token (4b-1 OA-flank-stations):
 *  the ordinary after-station pairs node→token with the caret on the fresh
 *  token (cell 1); the LEFT flank pairs token→node — typing inserts a node
 *  directly BEFORE the structure — with the caret on the fresh token
 *  (cell 0). */
function pairAgainst(ctx: Ctx, station: { readonly node: NodeJson; readonly ref: Ref } & FlankPair, newTok: NodeJson, caretAt: (cell: number) => Caret): EditingState {
  const at = replacePosOf(station.ref);
  return station.before
    ? place(ctx, implicitPair(newTok, station.node), at, caretAt(0))
    : place(ctx, implicitPair(station.node, newTok), at, caretAt(1));
}

/** Juxtapose `newTok` against the token station's node — before, after, or
 *  as the flat interior split (a different-type key between the halves,
 *  T3/S-029-style; S-031's number·symbol·number shape). */
function juxtaposeToken(ctx: Ctx, station: TokenStation, newTok: NodeJson, side: 'before' | 'after' | 'split'): EditingState {
  const { node, ref, offset } = station;
  const text = stationText(station);
  const at = replacePosOf(ref);
  const base = pathOf(ref);
  if (side === 'split' && offset > 0 && offset < text.length) {
    const left = node.type === 'sym' ? symFromText(text.slice(0, offset)) : numFromText(text.slice(0, offset));
    const right = node.type === 'sym' ? symFromText(text.slice(offset)) : numFromText(text.slice(offset));
    if (left === null || right === null) return ctx.state;
    const payload = { type: 'op', op: 'multiply', args: [left, newTok, right], implicit: true } as NodeJson;
    return place(ctx, payload, at, pairCaret(base, 1, newTok));
  }
  const after = side === 'after' || (side === 'split' && offset === text.length);
  if (after) {
    return place(ctx, implicitPair(node, newTok), at, pairCaret(base, 1, newTok));
  }
  return place(ctx, implicitPair(newTok, node), at, pairCaret(base, 0, newTok));
}

// ——— The seam core (shared leaf/juxtaposition mechanics) ———

interface Seam {
  readonly station: SeamStation;
  readonly atEnd: boolean;
  readonly atStart: boolean;
  readonly left: { readonly node: NodeJson | null; readonly path: Path } | null;
  readonly right: { readonly node: NodeJson | null; readonly path: Path } | null;
  readonly freeLeft: boolean;
}

function seamOf(env: Envelope, station: SeamStation): Seam {
  const { args, index, row } = station;
  const atEnd = index === args.length;
  // Digits/dots bond LEFT only across glyph-free adjacency — a separator
  // glyph at the station forbids extending the left neighbor's text.
  const freeLeft = index > 0 && (rowImplicit(row) || atEnd);
  return {
    station,
    atEnd,
    atStart: index === 0,
    left: index > 0 ? edgeCell(env, [...station.path, index - 1], 'last') : null,
    right: index < args.length ? edgeCell(env, [...station.path, index], 'first') : null,
    freeLeft,
  };
}

/** Glue a letter into the right symbol's front (crosses glyphs/commas — N2),
 *  the caret directly after the inserted text. */
function glueFront(ctx: Ctx, target: { node: NodeJson | null; path: Path }, text: string): EditingState {
  const name = tokenText(target.node as NodeJson);
  return place(ctx, symFromText(text + name), replacePosOf(refOfPath(target.path)), {
    kind: 'token', path: target.path, index: text.length,
  });
}

/** Glue into the left symbol's name / extend the left number's text (the
 *  seam survives the replace — still directly after the grown token). */
function growLeft(
  ctx: Ctx,
  target: { node: NodeJson | null; path: Path },
  grown: NodeJson,
): EditingState {
  return apply1(ctx, { op: 'insert', node: grown, at: replacePosOf(refOfPath(target.path)) });
}

/** A typed leaf at a seam fills a PENDING null when one sits adjacent:
 *  the null cell directly left of the seam (S-003's flow — `+|a` + typing
 *  `1` yields `1+a`), or the right edge's leading pending cell (S-006's
 *  continuation — the relocated glyph waits for its left operand). Returns
 *  null when neither applies (the caller walks its own rules on). */
function seamPendingFill(
  ctx: Ctx,
  station: SeamStation,
  seam: Seam,
  leaf: NodeJson,
  cellTo: (path: Path) => Caret,
): EditingState | null {
  if (station.index > 0 && station.args[station.index - 1] === null) {
    return place(ctx, leaf, { at: 'fill', path: station.path, index: station.index - 1 }, cellTo([...station.path, station.index - 1]));
  }
  if (seam.right !== null && seam.right.node === null) {
    // the right edge descends into a row whose first cell is pending
    return place(ctx, leaf, { at: 'fill', path: seam.right.path, index: 0 }, cellTo([...seam.right.path, 0]));
  }
  return null;
}

// ——— Digits ———

function digitKey(ctx: Ctx, station: Station, digits: string): EditingState {
  const num = numFromText(digits);
  if (num === null) return ctx.state;
  switch (station.kind) {
    case 'void':
      return place(ctx, num, posOf(station.ref), tokenEndCaret(pathOf(station.ref), num));
    case 'tok':
      return digitAtToken(ctx, station, digits, num);
    case 'after':
      // 4b-1 OA-flank-stations: the left flank pairs the digit directly
      // BEFORE the structure.
      return pairAgainst(ctx, station, num, (cell) => ({
        kind: 'token', path: [...pathOf(station.ref), cell], index: digits.length,
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      // 0. a pending null — left of the seam (S-003's `+|a` + `1` → 1+a) or
      //    at the right edge (S-006's continuation: `−|×b` + `2` → 2×b) —
      //    takes the leaf first.
      const filled = seamPendingFill(ctx, station, seam, num, (path) => tokenEndCaret(path, num));
      if (filled !== null) return filled;
      // 1. digit-glue: join the left symbol's name (letters to its left) —
      //    or append onto a left unit label (S-104's run; the grown label
      //    re-validates at the edit).
      if (seam.left !== null && seam.left.node !== null && !ctx.flagged) {
        if (seam.left.node.type === 'sym') {
          return growLeft(ctx, seam.left, symFromText(tokenText(seam.left.node) + digits));
        }
        if (seam.left.node.type === 'unit') {
          return unitGrow(ctx, seam.left, tokenText(seam.left.node) + digits, ctx.caret, ctx.caret);
        }
      }
      // 2. extend the left number's text (glyph-free adjacency only).
      if (seam.freeLeft && seam.left !== null && seam.left.node !== null && seam.left.node.type === 'num' && !ctx.flagged) {
        const grown = numFromText(tokenText(seam.left.node) + digits);
        if (grown !== null) return growLeft(ctx, seam.left, grown);
      }
      // 3. merge with a right-hand number (the chars land directly before it).
      if (seam.right !== null && seam.right.node !== null && seam.right.node.type === 'num') {
        const merged = numFromText(digits + tokenText(seam.right.node));
        if (merged !== null) {
          return place(ctx, merged, replacePosOf(refOfPath(seam.right.path)), {
            kind: 'token', path: seam.right.path, index: digits.length,
          });
        }
      }
      // 4. juxtapose onto the right cell — the number-before-X pair; the
      //    caret is the typed number's in-token end (OA-token-end — the
      //    pair seam right of it painted at the same spot).
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(num, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'token', path: [...seam.right.path, 0], index: digits.length,
        });
      }
      // 5. row end: juxtapose onto the left cell ([x, 5] + `7` → x+5·7 —
      //    with the Space flag on, the S-098 editing state).
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, implicitPair(seam.left.node, num), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'token', path: [...seam.left.path, 1], index: digits.length,
        });
      }
      // 6. no neighbor at all (an empty row): a fresh cell.
      return place(ctx, num, { at: 'row', path: station.path, index: station.index }, {
        kind: 'token', path: [...station.path, station.index], index: digits.length,
      });
    }
  }
}

function digitAtToken(ctx: Ctx, station: TokenStation, digits: string, num: NodeJson): EditingState {
  const { node, ref, offset } = station;
  const text = stationText(station);
  if (node.type === 'sym') {
    // Digit-glue: digits are symbol-name characters wherever letters exist
    // to their left; before letters (offset 0) a digit starts a number.
    if (offset > 0 && !ctx.flagged) {
      return growLeft(ctx, { node, path: station.path }, symFromText(text.slice(0, offset) + digits + text.slice(offset)));
    }
    return juxtaposeToken(ctx, station, num, offset === 0 ? 'before' : 'after');
  }
  if (node.type === 'unit') {
    // S-104 + the digit-glue amendment: a digit inside/after a unit label
    // extends the run text (the label re-validates at the edit — a digit
    // adding an unknown label reverts to the symbol pair). Against the armed
    // boundary a digit juxtaposes instead. A digit at the label's FRONT
    // (offset 0) has no letters to its left: the number-before-X pairing.
    if (ctx.flagged || offset === 0) {
      return juxtaposeToken(ctx, station, num, offset === text.length ? 'after' : 'split');
    }
    const grown = text.slice(0, offset) + digits + text.slice(offset);
    return unitGrow(
      ctx, station, grown,
      { kind: 'token', path: station.path, index: offset + digits.length },
      { kind: 'token', path: [...pathOf(ref), 1], index: offset + digits.length },
    );
  }
  if (node.type === 'sub' && !ctx.flagged && station.label !== undefined) {
    // T9: digits glue into the addressed label while the shape holds
    // (the base needs a leading letter; the script label is alnum).
    const grown = text.slice(0, offset) + digits + text.slice(offset);
    if (subLabelShapeOk(station.label, grown)) {
      const labels = node as { base: string; sub: string };
      const next =
        station.label === 'base' ? subJson(grown, labels.sub) : subJson(labels.base, grown);
      return place(ctx, next, replacePosOf(ref), {
        kind: 'token', path: station.path, index: offset + digits.length, label: station.label,
      });
    }
    return ctx.state;
  }
  if (ctx.flagged) {
    // Space-forced number-number adjacency (S-098): the state is legal and
    // renders the subtle seam marker; evaluation refuses while it persists.
    return place(ctx, implicitPair(node, num), replacePosOf(ref), {
      kind: 'row', path: pathOf(ref), index: 2,
    });
  }
  const next = numFromText(text.slice(0, offset) + digits + text.slice(offset));
  if (next === null) return ctx.state;
  return growLeft(ctx, { node, path: station.path }, next);
}

// ——— Letters ———

function letterKey(ctx: Ctx, station: Station, letters: string): EditingState {
  const sym = symFromText(letters);
  switch (station.kind) {
    case 'void':
      return place(ctx, sym, posOf(station.ref), tokenEndCaret(pathOf(station.ref), sym));
    case 'tok':
      return letterAtToken(ctx, station, letters, sym);
    case 'after':
      // 4b-1 OA-flank-stations: the left flank pairs the letters directly
      // BEFORE the structure.
      return pairAgainst(ctx, station, sym, (cell) => ({
        kind: 'token', path: [...pathOf(station.ref), cell], index: letters.length,
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      // 0. a pending null takes the leaf (S-003's leading flow, or a right
      //    edge waiting for its first operand).
      const filled = seamPendingFill(ctx, station, seam, sym, (path) => tokenEndCaret(path, sym));
      if (filled !== null) return filled;
      // 0.5 a head-less re-bind pair: letters SEED the future head symbol
      //     as a fresh leading cell — they never glue into the content that
      //     is waiting for its head (`|a+b)` + `cos` → [cos, a+b, `)`]);
      //     its inner seams then grow the standing head (rule 2), with the
      //     front-glue below suspended inside the pair.
      if (rebindTail(station.row)) {
        if (station.index === 0) {
          return place(ctx, sym, { at: 'row', path: station.path, index: 0 }, {
            kind: 'row', path: station.path, index: 1,
          });
        }
      } else if (seam.right !== null && seam.right.node !== null && !ctx.flagged) {
        // 1. glue into the right symbol's front (N2) — or into a right unit
        //    label's front (S-104: inside a unit label extends the run).
        if (seam.right.node.type === 'sym') {
          return glueFront(ctx, seam.right, letters);
        }
        if (seam.right.node.type === 'unit') {
          const grown = letters + tokenText(seam.right.node);
          return unitGrow(
            ctx, seam.right, grown,
            { kind: 'token', path: seam.right.path, index: letters.length },
            { kind: 'token', path: [...seam.right.path, 1], index: letters.length },
          );
        }
      }
      // 2. glue onto the left symbol (behind — T3's "front or behind") — or
      //    append onto a left unit label (S-104).
      if (seam.left !== null && seam.left.node !== null && !ctx.flagged) {
        if (seam.left.node.type === 'sym') {
          return growLeft(ctx, seam.left, symFromText(tokenText(seam.left.node) + letters));
        }
        if (seam.left.node.type === 'unit') {
          return unitGrow(ctx, seam.left, tokenText(seam.left.node) + letters, ctx.caret, ctx.caret);
        }
      }
      // 3/4. juxtapose onto the right / left cell (letters never merge with
      // numbers: S-032's juxtaposed symbol; symbol-before-X refuses at
      // evaluation — the ruling annotation, not a typing restriction). The
      // caret is the fresh symbol's in-token end (OA-token-end).
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(sym, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'token', path: [...seam.right.path, 0], index: letters.length,
        });
      }
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, implicitPair(seam.left.node, sym), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'token', path: [...seam.left.path, 1], index: letters.length,
        });
      }
      return place(ctx, sym, { at: 'row', path: station.path, index: station.index }, {
        kind: 'token', path: [...station.path, station.index], index: letters.length,
      });
    }
  }
}

function letterAtToken(ctx: Ctx, station: TokenStation, letters: string, sym: NodeJson): EditingState {
  const { node, ref, offset } = station;
  const text = stationText(station);
  if (node.type === 'sym') {
    if (!ctx.flagged) {
      const glued = symFromText(text.slice(0, offset) + letters + text.slice(offset));
      return apply1(ctx, { op: 'insert', node: glued, at: replacePosOf(ref) });
    }
    return juxtaposeToken(ctx, station, sym, offset === 0 ? 'before' : 'after');
  }
  if (node.type === 'unit') {
    // S-104: a letter inside/after a unit label extends the run (against
    // the armed boundary it juxtaposes a separate symbol instead, S-021).
    if (ctx.flagged) {
      return juxtaposeToken(ctx, station, sym, offset === 0 ? 'before' : offset === text.length ? 'after' : 'split');
    }
    const grown = text.slice(0, offset) + letters + text.slice(offset);
    return unitGrow(
      ctx, station, grown,
      { kind: 'token', path: station.path, index: offset + letters.length },
      { kind: 'token', path: [...pathOf(ref), 1], index: offset + letters.length },
    );
  }
  if (node.type === 'sub' && !ctx.flagged && station.label !== undefined) {
    // T9: letters glue into the addressed label; a shape-breaking glue is
    // a silent no-op (fromJSON would reject the grown label).
    const grown = text.slice(0, offset) + letters + text.slice(offset);
    if (subLabelShapeOk(station.label, grown)) {
      const labels = node as { base: string; sub: string };
      const next =
        station.label === 'base' ? subJson(grown, labels.sub) : subJson(labels.base, grown);
      return place(ctx, next, replacePosOf(ref), {
        kind: 'token', path: station.path, index: offset + letters.length, label: station.label,
      });
    }
    return ctx.state;
  }
  // A letter into a number: S-031's number·symbol·number split inside,
  // S-032's juxtaposed symbol at the edges — a letter never joins a number.
  return juxtaposeToken(ctx, station, sym, offset === 0 ? 'before' : offset === text.length ? 'after' : 'split');
}

// ——— The dot key (T4) ———

function dotKey(ctx: Ctx, station: Station): EditingState {
  const dotted = numFromText('0.');
  if (dotted === null) return ctx.state;
  switch (station.kind) {
    case 'void':
      return place(ctx, dotted, posOf(station.ref), { kind: 'token', path: pathOf(station.ref), index: 2 });
    case 'tok': {
      const { node, ref, offset } = station;
      const text = stationText(station);
      if (node.type === 'num') {
        if (text.includes('.')) return ctx.state; // second dot: silent no-op (S-013)
        const next = numFromText(text.slice(0, offset) + '.' + text.slice(offset));
        if (next === null) return ctx.state;
        return growLeft(ctx, { node, path: station.path }, next);
      }
      // Symbols never absorb dots: the `0.` is born adjacent (S-012/S-033).
      return juxtaposeToken(ctx, station, dotted, offset === 0 ? 'before' : offset === text.length ? 'after' : 'split');
    }
    case 'after':
      // 4b-1 OA-flank-stations: the left flank pairs the fresh `0.` directly
      // BEFORE the structure (caret inside it, after the dot).
      return pairAgainst(ctx, station, dotted, (cell) => ({
        kind: 'token', path: [...pathOf(station.ref), cell], index: 2,
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      // 0. a pending null births the `0.` there (everywhere a new number
      //    is born, S-012/S-033).
      const filled = seamPendingFill(ctx, station, seam, dotted, (path) => ({ kind: 'token', path, index: 2 }));
      if (filled !== null) return filled;
      // 1. join the left number as its decimal point (glyph-free only).
      if (seam.freeLeft && seam.left !== null && seam.left.node !== null && seam.left.node.type === 'num' && !ctx.flagged) {
        const text = tokenText(seam.left.node);
        if (text.includes('.')) return ctx.state; // silent no-op
        const joined = numFromText(text + '.');
        if (joined !== null) return growLeft(ctx, seam.left, joined);
      }
      // 2. juxtapose onto the right cell — the caret sits in the new `0.`
      //    directly after its dot.
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(dotted, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'token', path: [...seam.right.path, 0], index: 2,
        });
      }
      // 3. row end: juxtapose onto the left cell (S-012: `a` ” juxtaposed
      //    with `0.`).
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, implicitPair(seam.left.node, dotted), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'token', path: [...seam.left.path, 1], index: 2,
        });
      }
      return place(ctx, dotted, { at: 'row', path: station.path, index: station.index }, {
        kind: 'token', path: [...station.path, station.index], index: 2,
      });
    }
  }
}

// ——— Operator glyphs (T1) ———

function opKey(ctx: Ctx, station: Station, fn: OperatorFn): EditingState {
  switch (station.kind) {
    case 'void': {
      // A null args cell of a SAME-op parent row extends the flat chain:
      // one more pending cell, the glyph between it and the old one (`2−−`
      // builds toward the pinned flat [2,∅,3] shape — T1 alongside, the
      // math-style projection's own example). Everything else inserts the
      // [null, null] glyph template into the void.
      if (station.ref.at === 'cell') {
        const parent = nodeAt(ctx.env, station.ref.path) as NodeJson;
        if (parent.type === 'op' && !rowImplicit(parent) && (parent as { op: string }).op === fn) {
          const idx = station.ref.index + 1;
          return place(ctx, null, { at: 'row', path: station.ref.path, index: idx }, {
            kind: 'row', path: station.ref.path, index: idx,
          });
        }
      }
      return place(ctx, opRow(fn, [null, null]), posOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 1,
      });
    }
    case 'tok': {
      const { node, ref, offset } = station;
      const text = stationText(station);
      const at = replacePosOf(ref);
      // OA-mixed + OA-visual-trumps (4a): a token edge inside a GLYPH-LESS
      // (implicit) row IS the pair's seam — the same visual spot takes the
      // same typed-operator behavior (the glyph wraps the pair, which nests;
      // `5x|` + `*` → multiply[implicit{5,x}, null]). The row-caret seams
      // pre-4a reached the same tree through the seam station; typed results
      // now end in-token (OA-token-end), so the edge re-dispatches here.
      if (ref.at === 'cell' && (offset === 0 || offset === text.length)) {
        const parent = nodeAt(ctx.env, ref.path) as NodeJson;
        if (parent.type === 'op' && rowImplicit(parent)) {
          return opKey(ctx, {
            kind: 'seam',
            row: parent,
            path: ref.path,
            index: offset === 0 ? ref.index : ref.index + 1,
            args: rowArgs(parent),
          }, fn);
        }
      }
      // A token sitting in a SAME-op parent row extends the flat chain
      // (structural rule 3): the glyph splices another pending cell in at
      // the caret's side — before the token at offset 0 (a leading glyph),
      // after the token at offset len (the row keeps growing flat).
      if (ref.at === 'cell') {
        const parent = nodeAt(ctx.env, ref.path) as NodeJson;
        if (parent.type === 'op' && !rowImplicit(parent) && (parent as { op: string }).op === fn) {
          if (offset === 0 || offset === text.length) {
            const at2 = offset === 0 ? ref.index : ref.index + 1;
            return place(ctx, null, { at: 'row', path: ref.path, index: at2 }, {
              kind: 'row', path: ref.path, index: ref.index + 1,
            });
          }
        }
      }
      if (offset === 0) {
        return place(ctx, opRow(fn, [null, node]), at, { kind: 'row', path: pathOf(ref), index: 1 });
      }
      if (offset === text.length) {
        return place(ctx, opRow(fn, [node, null]), at, { kind: 'row', path: pathOf(ref), index: 1 });
      }
      // Interior offset: different-type input splits the token (T3/S-029) —
      // and a same-op parent row extends its flat chain instead of nesting.
      const left = node.type === 'sym' ? symFromText(text.slice(0, offset)) : numFromText(text.slice(0, offset));
      const right = node.type === 'sym' ? symFromText(text.slice(offset)) : numFromText(text.slice(offset));
      if (left === null || right === null) return ctx.state;
      if (ref.at === 'cell') {
        const parent = nodeAt(ctx.env, ref.path) as NodeJson;
        if (parent.type === 'op' && !rowImplicit(parent) && (parent as { op: string }).op === fn) {
          const cells = [...rowArgs(parent)];
          cells.splice(ref.index, 1, left, right);
          return place(ctx, opRow(fn, cells), replacePosOf(refOfPath(ref.path)), {
            kind: 'token', path: [...ref.path, ref.index + 1], index: 0,
          });
        }
      }
      return place(ctx, opRow(fn, [left, right]), at, {
        kind: 'token', path: [...pathOf(ref), 1], index: 0,
      });
    }
    case 'after': {
      // 4b-1 OA-flank-stations: at the left flank the glyph template gets a
      // null LEFT cell (the structure rides as its right operand, the glyph
      // directly before it); the caret rests in both shapes' pending cell.
      const cells = station.before
        ? [null, station.node as NodeJson | null]
        : [station.node as NodeJson | null, null];
      return place(ctx, opRow(fn, cells), replacePosOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 1,
      });
    }
    case 'seam': {
      const { row, path, index, args } = station;
      const sameOp = row.type === 'op' && !rowImplicit(row) && (row as { op: string }).op === fn;
      if (sameOp) {
        // Null-cell splice: the row gains a separator slot whose operand
        // stays pending — leading, interior, trailing all legal (T1).
        // Interior: the caret sits directly after the new glyph; at a row
        // end it rests IN the fresh pending cell (the natural continue).
        return place(ctx, null, { at: 'row', path, index }, {
          kind: 'row', path, index: index === args.length ? index : index + 1,
        });
      }
      return wrapAtSeam(ctx, station, fn);
    }
  }
}

/** A different-op glyph at a seam wraps: the row's left part becomes the
 *  glyph's left operand, the right part (carrying the station's own
 *  separator as a leading pending cell — S-006: the glyph inserts BEFORE an
 *  existing operator) its right operand. Implicit rows have no glyph to
 *  relocate: their juxtaposed pairs simply fall apart into the segments. */
function wrapAtSeam(ctx: Ctx, station: SeamStation, fn: OperatorFn): EditingState {
  const { row, path, index, args } = station;
  const rowRef = refOfPath(path);
  const rowAt = replacePosOf(rowRef);
  const rowPath = pathOf(rowRef);
  if (index === args.length) {
    return place(ctx, opRow(fn, [rowClone(row, args), null]), rowAt, { kind: 'row', path: rowPath, index: 1 });
  }
  if (index === 0) {
    return place(ctx, opRow(fn, [null, rowClone(row, args)]), rowAt, { kind: 'row', path: rowPath, index: 1 });
  }
  if (row.type === 'fn') {
    // Fenced row: cells keep their commas — only the right cell wraps,
    // carrying the glyph as a leading pending cell inside it.
    const next = [...args.slice(0, index), opRow(fn, [null, args[index]]), ...args.slice(index + 1)];
    return place(ctx, rowClone(row, next), rowAt, { kind: 'row', path: [...path, index], index: 1 });
  }
  const leftCells = args.slice(0, index);
  const rightCells = args.slice(index);
  const leftSeg = leftCells.length === 1 ? leftCells[0] : rowClone(row, leftCells);
  const rightSeg = rowImplicit(row)
    ? rightCells.length === 1 ? rightCells[0] : rowClone(row, rightCells)
    : opRow((row as { op: string }).op as OperatorFn, [null, ...rightCells]);
  return place(ctx, opRow(fn, [leftSeg, rightSeg]), rowAt, { kind: 'row', path: rowPath, index: 1 });
}

// ——— Group open: T5 paren-conversion, else T6 group creation ———

const knownFunctions = (state: EditingState): ReadonlySet<string> =>
  new Set(state.vocabulary?.functions ?? defaultStaticVocabulary.functions);

/** T10: the auto closing fence is added ONLY when no elements stand to the
 *  right of the caret (content right of the symbol inside its row). */
function contentRightOf(env: Envelope, ref: Ref): boolean {
  if (ref.at !== 'cell') return false;
  const row = nodeAt(env, ref.path);
  if (row === null || (row.type !== 'op' && row.type !== 'fn')) return false;
  return rowArgs(row).slice(ref.index + 1).some((cell) => cell !== null);
}

/** `(` at the seam directly after a seeded head symbol inside a head-less
 *  re-bind pair re-heads the content (the ruled D7 swap workflow, S-086;
 *  the owner's B-22 live check): the WHOLE pair becomes one fenced fn —
 *  the cells between the symbol and the waiting fence are its single
 *  argument (the fence token re-binds as the fn's close — the S-097
 *  completion shape): `|a+b)` + `cos(` → `cos(a+b)`. Non-matching names and
 *  other seams take the ordinary T5/T6 paths. One op — undo unwinds the
 *  whole re-heading. */
function rebindHeadOf(ctx: Ctx, station: SeamStation): EditingState | null {
  if (!rebindTail(station.row) || station.index !== 1) return null;
  const args = rowArgs(station.row);
  const head = args[0];
  if (head === null || head.type !== 'sym' || !knownFunctions(ctx.state).has(tokenText(head))) return null;
  const argCells = args.slice(1, -1);
  const arg: NodeJson | null =
    argCells.length === 0
      ? null
      : argCells.length === 1
        ? (argCells[0] as NodeJson | null)
        : ({ type: 'op', op: 'multiply', args: argCells, implicit: true } as NodeJson);
  const made = fnJson(tokenText(head), argCells.length === 0 ? [null] : [arg], true);
  return place(ctx, made, replacePosOf(refOfPath(station.path)), {
    kind: 'row', path: station.path, index: 0,
  });
}

function openKey(ctx: Ctx, station: Station): EditingState {
  switch (station.kind) {
    case 'void':
      return place(ctx, groupJson(null, true), posOf(station.ref), {
        kind: 'slot', path: pathOf(station.ref), slot: 'child',
      });
    case 'tok': {
      const { node, ref, offset } = station;
      // T5: `(` after a symbol whose name matches a known function converts
      // it into the atomic head (the caret inside the first argument).
      if (node.type === 'sym' && knownFunctions(ctx.state).has(tokenText(node))) {
        const bare = contentRightOf(ctx.env, ref);
        return place(ctx, fnJson(tokenText(node), [null], !bare), replacePosOf(ref), {
          kind: 'row', path: pathOf(ref), index: 0,
        });
      }
      // T6: a group with both fences at the caret; content to the left
      // stays outside (the juxtaposition pairing handles that).
      const group = groupJson(null, true);
      return juxtaposeToken(ctx, station, group, offset === 0 ? 'before' : offset === stationText(station).length ? 'after' : 'split');
    }
    case 'after':
      // 4b-1 OA-flank-stations: at the left flank the fresh group pairs
      // directly BEFORE the structure (T6's content-to-the-left reading
      // mirrored: the structure becomes the group's right content).
      return pairAgainst(ctx, station, groupJson(null, true), (cell) => ({
        kind: 'slot', path: [...pathOf(station.ref), cell], slot: 'child',
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      const reHead = rebindHeadOf(ctx, station);
      if (reHead !== null) return reHead;
      // T5 at a glyph-free gap: the left-adjacent symbol converts.
      if (seam.left !== null && seam.left.node !== null && seam.left.node.type === 'sym' &&
          knownFunctions(ctx.state).has(tokenText(seam.left.node))) {
        const leftRef = refOfPath(seam.left.path);
        const bare = contentRightOf(ctx.env, leftRef);
        return place(ctx, fnJson(tokenText(seam.left.node), [null], !bare), replacePosOf(leftRef), {
          kind: 'row', path: seam.left.path, index: 0,
        });
      }
      const group = groupJson(null, true);
      // T6's content-to-the-left reading: the left partner wins where both
      // sides are free.
      if (seam.left !== null && seam.left.node !== null && seam.freeLeft) {
        return place(ctx, implicitPair(seam.left.node, group), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'slot', path: [...seam.left.path, 1], slot: 'child',
        });
      }
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(group, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'slot', path: [...seam.right.path, 0], slot: 'child',
        });
      }
      return place(ctx, group, { at: 'row', path: station.path, index: station.index }, {
        kind: 'slot', path: [...station.path, station.index], slot: 'child',
      });
    }
  }
}

// ——— Group close: S-097 pairing, else the dangling fence token ———

/** Complete the innermost unclosed open fence to the caret's left: flip its
 *  close to true (one op), land directly after the container. */
function completeFence(ctx: Ctx, target: Ancestor): EditingState {
  const rebuilt =
    target.node.type === 'group'
      ? groupJson((target.node as { child: NodeJson | null }).child, true)
      : fnJson((target.node as { name: string }).name, rowArgs(target.node), true);
  const ref = refOfPath(target.path);
  const after: Envelope = JSON.parse(JSON.stringify(ctx.env)) as Envelope;
  if (ref.at === 'root') {
    after.root = rebuilt;
  } else if (ref.at === 'slot') {
    (nodeAt(after, ref.path) as unknown as Record<string, unknown>)[ref.slot] = rebuilt;
  } else {
    rowArgs(nodeAt(after, ref.path) as NodeJson)[ref.index] = rebuilt;
  }
  const to = exitStation(after, target.path, 'right') ?? { kind: 'node', path: target.path };
  return place(ctx, rebuilt, replacePosOf(ref), to);
}

function closeKey(ctx: Ctx, station: Station): EditingState {
  const unclosed = unclosedOf(ctx.env, ctx.caret);
  if (unclosed !== null) return completeFence(ctx, unclosed);
  const fence: NodeJson = { type: 'fence', side: 'close' };
  switch (station.kind) {
    case 'void':
      return place(ctx, fence, posOf(station.ref), { kind: 'node', path: pathOf(station.ref) });
    case 'tok':
      return juxtaposeToken(ctx, station, fence, station.offset === 0 ? 'before' : station.offset === stationText(station).length ? 'after' : 'split');
    case 'after':
      // 4b-1 OA-flank-stations: at the left flank the dangling close token
      // pairs directly BEFORE the structure (caret on the fence cell's
      // seam; the ordinary after-station seats it after its pair).
      return pairAgainst(ctx, station, fence, (cell) => ({
        kind: 'row', path: pathOf(station.ref), index: cell + 1,
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      if (seam.left !== null && seam.left.node !== null && seam.freeLeft) {
        return place(ctx, implicitPair(seam.left.node, fence), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'row', path: seam.left.path, index: 2,
        });
      }
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(fence, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'row', path: seam.right.path, index: 1,
        });
      }
      return place(ctx, fence, { at: 'row', path: station.path, index: station.index }, {
        kind: 'row', path: station.path, index: station.index + 1,
      });
    }
  }
}

// ——— Comma (T5): append an argument cell to the nearest fn ———

function commaKey(ctx: Ctx): EditingState {
  const fn = nearestFnOf(ctx.env, ctx.caret);
  if (fn === null) return ctx.state; // outside any call: silent no-op
  const args = rowArgs(fn.node);
  return place(ctx, rowClone(fn.node, [...args, null]), replacePosOf(refOfPath(fn.path)), {
    kind: 'row', path: fn.path, index: args.length,
  });
}

// ——— Space (T3, S-021/S-022) ———

function spaceKey(ctx: Ctx, station: Station): EditingState {
  switch (station.kind) {
    case 'tok': {
      const { node, ref, offset } = station;
      const text = stationText(station);
      if (node.type === 'unit' && offset > 0 && offset < text.length) {
        // Space splits a unit label run like a symbol (S-098's separation
        // family): the value keeps its own glyph-less cell (a unit needs a
        // value — it never flies apart into the split), both label halves
        // revert to ordinary symbols; the result is NOT a convertible pair
        // (a settle never touches it — the explicit break stands).
        const value = (node as { value: NodeJson }).value;
        const payload = {
          type: 'op', op: 'multiply',
          args: [value, symFromText(text.slice(0, offset)), symFromText(text.slice(offset))],
          implicit: true,
        } as NodeJson;
        return place(ctx, payload, replacePosOf(ref), {
          kind: 'row', path: pathOf(ref), index: 2,
        });
      }
      if (offset > 0 && offset < text.length) {
        // Inside a token: split it into two glyph-less adjacent nodes —
        // two symbols (S-021's same-type state) or S-098's forced
        // number-number adjacency (the editing state; refuses evaluation).
        // (A sub label's halves are unrepresentable — a silent no-op.)
        const left = node.type === 'sym' ? symFromText(text.slice(0, offset)) : numFromText(text.slice(0, offset));
        const right = node.type === 'sym' ? symFromText(text.slice(offset)) : numFromText(text.slice(offset));
        if (left === null || right === null) return ctx.state;
        return place(ctx, implicitPair(left, right), replacePosOf(ref), {
          kind: 'row', path: pathOf(ref), index: 1,
        });
      }
      return armed(ctx); // at a token edge: arm the boundary — never logged
    }
    case 'seam':
      return armed(ctx); // separations apply at the shared gap too
    default:
      return ctx.state; // a void/after has nothing to separate
  }
}

// ——— Structure keys: the T7 fraction/power contract (rework session 2b) ———
//
// T7 + the owner's uniform split ruling (2026-11-09): a structure key reads
// the caret as a split point of the visual row — the content left of the
// caret becomes the numerator/base, the content right fills or pends in the
// denominator/exponent, and the caret lands at the START of the right slot
// (S-018/S-019): before the □ when the right side is empty (a slot caret),
// at the right half's first character when it exists (a token caret). The
// station readings:
//  TOKEN  — the token splits; `12|3` + `/` → frac(12, 3). Offset len is the
//           ordinary whole-node grab + □, offset 0 the □ left slot with the
//           token in the right slot — the same uniform reading's edges.
//  AFTER  — a caret directly after a complete non-row node grabs it whole
//           (`(a+b)|` grabs the group — the owner's example).
//  SEAM   — the immediately preceding NODE (the left edge cell, op rows
//           transparent at their flanks) is grabbed, the rest of the row
//           untouched (`a+b|` grabs only b).
//  VOID   — no node exists to grab (empty formula, empty fixed slot, a
//           pending null): the empty template — a fraction with BOTH slots
//           □ and the caret in the numerator (S-025 A), a power with the
//           empty base □ and the caret in the exponent. The same template
//           serves a seam without a left node: it fills the pending
//           operand to its left (`a+|`) or juxtaposes before the right
//           cell at a row start.

function structureKey(ctx: Ctx, station: Station, kind: 'divide' | 'pow'): EditingState {
  const mk = (a: NodeJson | null, b: NodeJson | null): NodeJson =>
    kind === 'divide' ? ({ type: 'frac', num: a, den: b } as NodeJson) : ({ type: 'pow', base: a, exp: b } as NodeJson);
  const leftSlot: SlotName = kind === 'divide' ? 'num' : 'base';
  const rightSlot: SlotName = kind === 'divide' ? 'den' : 'exp';
  /** The empty template's entry slot: the numerator (S-025 A) / the
   *  exponent (the session-2b-1 derived reading). */
  const entrySlot: SlotName = kind === 'divide' ? leftSlot : rightSlot;
  switch (station.kind) {
    case 'void':
      return place(ctx, mk(null, null), posOf(station.ref), {
        kind: 'slot', path: pathOf(station.ref), slot: entrySlot,
      });
    case 'tok': {
      const { node, ref, offset } = station;
      const text = stationText(station);
      const base = pathOf(ref);
      // A unit label or sub label never splits into halves (a unit cannot
      // fly apart from its value; a sub is atomic node-wise): its edges read
      // as whole-node grabs for the T7 split instead, interior label offsets
      // are silent no-ops (the halves below cannot represent them).
      if ((node.type === 'unit' || node.type === 'sub') && (offset === 0 || offset === text.length)) {
        const structPath = base;
        const to: Caret = offset === 0
          ? node.type === 'unit'
            ? { kind: 'token', path: [...structPath, rightSlot], index: 0 }
            : { kind: 'token', path: [...structPath, rightSlot], index: 0, label: 'base' }
          : { kind: 'slot', path: structPath, slot: rightSlot };
        return place(ctx, mk(offset === 0 ? null : node, offset === 0 ? node : null), replacePosOf(ref), to);
      }
      let left: NodeJson | null = null;
      if (offset > 0) {
        left = node.type === 'sym' ? symFromText(text.slice(0, offset)) : numFromText(text.slice(0, offset));
        if (left === null) return ctx.state; // unrepresentable half: silent no-op
      }
      let right: NodeJson | null = null;
      if (offset < text.length) {
        right = node.type === 'sym' ? symFromText(text.slice(offset)) : numFromText(text.slice(offset));
        if (right === null) return ctx.state; // unrepresentable half: silent no-op
      }
      const structPath = pathOf(ref);
      // Uniform split: caret at the START of the right slot — before the
      // right half's content when it exists, before the □ otherwise.
      const to: Caret =
        right === null
          ? { kind: 'slot', path: structPath, slot: rightSlot }
          : { kind: 'token', path: [...structPath, rightSlot], index: 0 };
      return place(ctx, mk(left, right), replacePosOf(ref), to);
    }
    case 'after':
      // 4b-1 OA-flank-stations: the AFTER station grabs the structure whole
      // as the left slot (T7's ruled `(a+b)|` grab); the LEFT flank mirrors
      // it — the structure becomes the RIGHT slot with a □ left slot and
      // the caret in it (the OA-both-halves uniform reading's edges).
      return station.before
        ? place(ctx, mk(null, station.node), replacePosOf(station.ref), {
            kind: 'slot', path: pathOf(station.ref), slot: leftSlot,
          })
        : place(ctx, mk(station.node, null), replacePosOf(station.ref), {
            kind: 'slot', path: pathOf(station.ref), slot: rightSlot,
          });
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, mk(seam.left.node, null), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'slot', path: seam.left.path, slot: rightSlot,
        });
      }
      const empty = mk(null, null);
      // No preceding node — the derived empty template. A pending null
      // directly left of the seam takes it (the dangling operator's
      // operand); so does the right edge's leading pending cell; at a row
      // start the template juxtaposes before the right cell; with nothing
      // adjacent at all it splices in as a fresh cell at the seam.
      if (station.index > 0 && station.args[station.index - 1] === null) {
        const idx = station.index - 1;
        return place(ctx, empty, { at: 'fill', path: station.path, index: idx }, {
          kind: 'slot', path: [...station.path, idx], slot: entrySlot,
        });
      }
      if (seam.right !== null && seam.right.node === null) {
        return place(ctx, empty, { at: 'fill', path: seam.right.path, index: 0 }, {
          kind: 'slot', path: [...seam.right.path, 0], slot: entrySlot,
        });
      }
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(empty, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'slot', path: [...seam.right.path, 0], slot: entrySlot,
        });
      }
      return place(ctx, empty, { at: 'row', path: station.path, index: station.index }, {
        kind: 'slot', path: [...station.path, station.index], slot: entrySlot,
      });
    }
  }
}

// ——— T9: the keyless-structure insertion vocabulary (rework session 2b-2) ———
//
// Root and subscript have no entry keys (the suggestion box and the palette
// ride on this surface). Owner ruling 2026-11-09 (forward-grab): the root
// OPENS at the caret — it wraps the content that FOLLOWS the caret; the
// left-of-caret content stays in the row before it (a mid-token insert
// splices: the right half goes under the radical, the left half juxtaposes
// before the root). The caret comes to rest at the BEGINNING of the radicand
// (its first text position when the radicand is a token); with nothing to
// grab the radicand is a □ the caret sits in; a caret in a PENDING null
// cell grabs the right operand (a+|b → a+√b). Square root = the v1
// index-omitted form; the general root (mroot) grabs the same way and leaves
// the index an EMPTY □ slot (the flag never combines with a filled
// index — fromJSON's contract). The subscript converts the left-adjacent
// symbol into the base (T5's conversion shape); its label strings are
// caret-addressable one at a time (T9 ruling: a token caret on a sub
// carries `label` — letters/digits glue into the addressed label while
// its contracted identifier shape holds). One insert = one op = one log
// entry; undo unwinds the whole creation (S-083).

/** The insertion guard typeToken uses: an unresolvable caret is a typed
 *  rejection, never a silent wrong placement. */
function resolvableStationOf(state: EditingState): { ctx: Ctx; station: Station } {
  const env = envelopeOf(state);
  if (!caretResolvesIn(env, state.caret)) {
    throw new EngineError(
      'not-a-typing-point',
      `caret does not resolve in this envelope (${JSON.stringify(state.caret)})`,
    );
  }
  return {
    ctx: { env, state, caret: state.caret, flagged: state.caret.boundary === true },
    station: stationOf(env, state.caret),
  };
}

/** Shift a caret that pointed at/into the grabbed subtree one level down:
 *  after the grab the content sits under the fresh radicand slot of the
 *  root that replaced it in place. */
function underRadicand(caret: Caret, at: number): Caret {
  if (caret.kind === 'empty') return caret; // unreachable: a grabbed entry caret is never empty
  const path = [...caret.path];
  path.splice(at, 0, 'radicand');
  return { ...caret, path };
}

/** Grab the node at `targetPath` into a fresh root, replacing it in place;
 *  the caret lands at the radicand's beginning (T7's right-slot rule: the
 *  entry station of the still-unchanged subtree, one level deeper). */
function grabCell(ctx: Ctx, targetPath: Path, mk: (radicand: NodeJson | null) => NodeJson): EditingState {
  const target = nodeAt(ctx.env, targetPath) as NodeJson;
  const entry = entryStation(ctx.env, targetPath, 'left') ?? { kind: 'node', path: targetPath };
  return place(ctx, mk(target), replacePosOf(refOfPath(targetPath)), underRadicand(entry, targetPath.length));
}

/** Root insertion (T9): `opts.mroot` selects the n-th-root form (empty □
 *  index slot); default = square root (index omitted, the v1 rule). Pure:
 *  returns the next state. */
export function insertRoot(state: EditingState, opts: { readonly mroot?: boolean } = {}): EditingState {
  const rootOf = (radicand: NodeJson | null): NodeJson =>
    (opts.mroot === true
      ? { type: 'root', radicand, index: null, mroot: true }
      : { type: 'root', radicand }) as NodeJson;
  const emptyInto = (rootPath: Path): Caret => ({ kind: 'slot', path: rootPath, slot: 'radicand' });
  const { ctx, station } = resolvableStationOf(state);
  switch (station.kind) {
    case 'void': {
      if (station.ref.at === 'cell') {
        const args = rowArgs(nodeAt(ctx.env, station.ref.path) as NodeJson);
        const after = station.ref.index + 1;
        if (after < args.length && args[after] !== null) {
          // A caret IN a pending null cell grabs the right operand.
          return grabCell(ctx, [...station.ref.path, after], rootOf);
        }
        return place(
          ctx, rootOf(null),
          { at: 'fill', path: station.ref.path, index: station.ref.index },
          emptyInto([...station.ref.path, station.ref.index]),
        );
      }
      return place(ctx, rootOf(null), posOf(station.ref), emptyInto(pathOf(station.ref)));
    }
    case 'tok': {
      const { node, ref, offset } = station;
      const text = stationText(station);
      const base = pathOf(ref);
      if (offset === 0) {
        // Whole-token grab at the token's left end: the radicand's
        // beginning is the token's own offset 0.
        return place(ctx, rootOf(node), replacePosOf(ref), {
          kind: 'token', path: [...base, 'radicand'], index: 0,
        });
      }
      if (offset < text.length) {
        const left = node.type === 'sym' ? symFromText(text.slice(0, offset)) : numFromText(text.slice(0, offset));
        const right = node.type === 'sym' ? symFromText(text.slice(offset)) : numFromText(text.slice(offset));
        if (left === null || right === null) return ctx.state; // unrepresentable half: silent no-op
        return place(ctx, implicitPair(left, rootOf(right)), replacePosOf(ref), {
          kind: 'token', path: [...base, 1, 'radicand'], index: 0,
        });
      }
      // Nothing right of the caret: the □ template juxtaposes after.
      return place(ctx, implicitPair(node, rootOf(null)), replacePosOf(ref), {
        kind: 'slot', path: [...base, 1], slot: 'radicand',
      });
    }
    case 'after': {
      if (station.before) {
        // 4b-1 OA-flank-stations: the structure right of the left flank
        // goes under the radical (the forward-grab's uniform reading) —
        // the caret at the radicand's beginning.
        return grabCell(ctx, station.path, rootOf);
      }
      const fwd = forwardCellOf(ctx.env, station.ref);
      if (fwd !== null) {
        if (fwd.drop) {
          return place(ctx, rootOf(null), { at: 'fill', path: fwd.path, index: fwd.index }, emptyInto([...fwd.path, fwd.index]));
        }
        return grabCell(ctx, [...fwd.path, fwd.index], rootOf);
      }
      // A complete structure at a slot/root with no following cell: the □
      // template juxtaposes after the node.
      const base = pathOf(station.ref);
      return place(ctx, implicitPair(station.node, rootOf(null)), replacePosOf(station.ref), {
        kind: 'slot', path: [...base, 1], slot: 'radicand',
      });
    }
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      if (seam.right !== null && seam.right.node !== null) {
        return grabCell(ctx, seam.right.path, rootOf);
      }
      if (seam.right !== null) {
        // The right edge descends into a row whose leading cell pends.
        return place(ctx, rootOf(null), { at: 'fill', path: seam.right.path, index: 0 }, emptyInto([...seam.right.path, 0]));
      }
      if (station.index > 0 && station.args[station.index - 1] === null) {
        // The row's own pending cell just left of the seam takes the □.
        return place(ctx, rootOf(null), { at: 'fill', path: station.path, index: station.index - 1 }, emptyInto([...station.path, station.index - 1]));
      }
      // Row end: the □ template splices in as a fresh cell.
      return place(ctx, rootOf(null), { at: 'row', path: station.path, index: station.index }, emptyInto([...station.path, station.index]));
    }
  }
}

/** The row-cell FORWARD of a ref (insertions at after-stations): the args
 *  cell after the ref's own — null when the node sits at a slot/root (no
 *  row cell follows); `drop: true` when that cell pends or the row ended
 *  (the □ template fills it instead of grabbing). */
function forwardCellOf(
  env: Envelope,
  ref: Ref,
): { readonly path: Path; readonly index: number; readonly drop: boolean } | null {
  if (ref.at !== 'cell') return null;
  const args = rowArgs(nodeAt(env, ref.path) as NodeJson);
  const i = ref.index + 1;
  return { path: ref.path, index: i, drop: i >= args.length || args[i] === null };
}

/** Subscript insertion (T9, v1 label mode): the left-adjacent symbol
 *  converts into the base (T5's conversion shape, offset irrelevant) with
 *  the caret in the empty script label; anywhere else the empty
 *  sub{base:'', sub:''} template is placed with the caret in the BASE label
 *  (the first thing typed). A symbol whose name is not identifier-shaped
 *  cannot become a base — the template juxtaposes instead. */
export function insertSubscript(state: EditingState): EditingState {
  const empty = subJson('', '');
  const { ctx, station } = resolvableStationOf(state);
  const baseCaret = (path: Path): Caret => ({ kind: 'token', path, index: 0, label: 'base' });
  const scriptCaret = (path: Path): Caret => ({ kind: 'token', path, index: 0, label: 'sub' });
  switch (station.kind) {
    case 'void':
      return place(ctx, empty, posOf(station.ref), baseCaret(pathOf(station.ref)));
    case 'tok': {
      const { node, ref, offset } = station;
      if (node.type === 'sym' && subLabelShapeOk('base', tokenText(node))) {
        return place(ctx, subJson(tokenText(node), ''), replacePosOf(ref), scriptCaret(station.path));
      }
      return juxtaposeToken(ctx, station, empty, offset === 0 ? 'before' : offset === stationText(station).length ? 'after' : 'split');
    }
    case 'after':
      return pairAgainst(ctx, station, empty, (cell) => ({
        kind: 'token', path: [...pathOf(station.ref), cell], index: 0, label: 'base',
      }));
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      if (seam.left !== null && seam.left.node !== null && seam.left.node.type === 'sym' &&
          subLabelShapeOk('base', tokenText(seam.left.node))) {
        return place(ctx, subJson(tokenText(seam.left.node), ''), replacePosOf(refOfPath(seam.left.path)), scriptCaret(seam.left.path));
      }
      if (station.index > 0 && station.args[station.index - 1] === null) {
        const idx = station.index - 1;
        return place(ctx, empty, { at: 'fill', path: station.path, index: idx }, baseCaret([...station.path, idx]));
      }
      if (seam.right !== null && seam.right.node === null) {
        return place(ctx, empty, { at: 'fill', path: seam.right.path, index: 0 }, baseCaret([...seam.right.path, 0]));
      }
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(empty, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'token', path: [...seam.right.path, 0], index: 0, label: 'base',
        });
      }
      return place(ctx, empty, { at: 'row', path: station.path, index: station.index }, baseCaret([...station.path, station.index]));
    }
  }
}
// ——— The typing surface ———

/** Type one token into the session (the T1–T6 rules + amendments). Pure:
 *  returns the next state. Rejected keys are silent no-ops (the standing
 *  rejection pattern): the same state object comes back, nothing is logged.
 *  Throws EngineError only on an unresolvable caret (the editor treats the
 *  typed rejections as defined no-ops). */
export function typeToken(state: EditingState, token: TypedToken): EditingState {
  const env = envelopeOf(state);
  if (!caretResolvesIn(env, state.caret)) {
    throw new EngineError(
      'not-a-typing-point',
      `caret does not resolve in this envelope (${JSON.stringify(state.caret)})`,
    );
  }
  const ctx: Ctx = { env, state, caret: state.caret, flagged: state.caret.boundary === true };
  const station = stationOf(env, state.caret);
  switch (token.t) {
    case 'space':
      return spaceKey(ctx, station);
    case 'comma':
      return commaKey(ctx);
    case 'dot':
      return dotKey(ctx, station);
    case 'groupOpen':
      return openKey(ctx, station);
    case 'groupClose':
      return closeKey(ctx, station);
    case 'operator':
      return opKey(ctx, station, token.fn);
    case 'divide':
    case 'pow':
      return structureKey(ctx, station, token.t);
    case 'leaf':
      if (token.node.type === 'num') return digitKey(ctx, station, String(token.node.value));
      if (token.node.type === 'sym') return letterKey(ctx, station, token.node.name);
      return ctx.state; // other leaf kinds: outside the typing keymap (no-op)
  }
}
