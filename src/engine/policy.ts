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
  tokenText,
  type Caret,
  type Path,
  type Ref,
  type SlotName,
} from './caret.js';
import { EngineError } from './errors.js';
import { exitStation } from './nav.js';
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

const fnJson = (name: string, args: (NodeJson | null)[], close: boolean): NodeJson =>
  close ? { type: 'fn', name, args } : { type: 'fn', name, args, close: false };

const groupJson = (child: NodeJson | null, close: boolean): NodeJson =>
  ({ type: 'group', parens: 'always', child, ...(close ? {} : { close: false }) }) as NodeJson;

/** The glyph-less juxtaposition pair: its own implicit-multiply subrow. */
const implicitPair = (a: NodeJson | null, b: NodeJson | null): NodeJson =>
  ({ type: 'op', op: 'multiply', args: [a, b], implicit: true }) as NodeJson;

/** A num from literal text (digits + one dot; a trailing dot is the
 *  in-progress `dot` state, T4). Null when unrepresentable. */
const numFromText = (text: string): NodeJson | null => {
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return text.endsWith('.') ? ({ type: 'num', value, dot: true } as NodeJson) : ({ type: 'num', value } as NodeJson);
};

const symFromText = (name: string): NodeJson => ({ type: 'sym', name }) as NodeJson;

/** An op row (n-ary, so same-op glyphs render between the cells). */
const opRow = (fn: OperatorFn, args: (NodeJson | null)[]): NodeJson =>
  ({ type: 'op', op: fn, args }) as NodeJson;

/** Clone an op/fn row with new cells, preserving name/implicit/close. */
function rowClone(kind: NodeJson, cells: readonly (NodeJson | null)[]): NodeJson {
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
}

interface VoidStation {
  readonly kind: 'void';
  readonly ref: Ref;
  readonly path: Path;
}

type Station = TokenStation | SeamStation | AfterStation | VoidStation;

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

/** The caret for a freshly juxtaposed token: inside a `0.`
 *  number after its dot (S-012/S-033), inside a fresh group's content slot
 *  (T6 — typing continues between the fences), else on the pair seam
 *  directly after the inserted token. */
function pairCaret(base: Path, cell: number, newTok: NodeJson): Caret {
  if (newTok.type === 'num' && (newTok as { dot?: boolean }).dot === true) {
    return { kind: 'token', path: [...base, cell], index: 2 };
  }
  if (newTok.type === 'group') {
    return { kind: 'slot', path: [...base, cell], slot: 'child' };
  }
  return { kind: 'row', path: base, index: cell + 1 };
}

/** Juxtapose `newTok` against the token station's node — before, after, or
 *  as the flat interior split (a different-type key between the halves,
 *  T3/S-029-style; S-031's number·symbol·number shape). */
function juxtaposeToken(ctx: Ctx, station: TokenStation, newTok: NodeJson, side: 'before' | 'after' | 'split'): EditingState {
  const { node, ref, offset } = station;
  const text = tokenText(node);
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
      return apply1(ctx, { op: 'insert', node: num, at: posOf(station.ref) });
    case 'tok':
      return digitAtToken(ctx, station, digits, num);
    case 'after':
      return place(ctx, implicitPair(station.node, num), replacePosOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 2,
      });
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      // 0. a pending null — left of the seam (S-003's `+|a` + `1` → 1+a) or
      //    at the right edge (S-006's continuation: `−|×b` + `2` → 2×b) —
      //    takes the leaf first.
      const filled = seamPendingFill(ctx, station, seam, num, (path) => ({ kind: 'node', path }));
      if (filled !== null) return filled;
      // 1. digit-glue: join the left symbol's name (letters to its left).
      if (seam.left !== null && seam.left.node !== null && seam.left.node.type === 'sym' && !ctx.flagged) {
        return growLeft(ctx, seam.left, symFromText(tokenText(seam.left.node) + digits));
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
      // 4. juxtapose onto the right cell — the number-before-X pair.
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(num, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'row', path: seam.right.path, index: 1,
        });
      }
      // 5. row end: juxtapose onto the left cell ([x, 5] + `7` → x+5·7 —
      //    with the Space flag on, the S-098 editing state).
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, implicitPair(seam.left.node, num), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'row', path: seam.left.path, index: 2,
        });
      }
      // 6. no neighbor at all (an empty row): a fresh cell.
      return place(ctx, num, { at: 'row', path: station.path, index: station.index }, {
        kind: 'row', path: station.path, index: station.index + 1,
      });
    }
  }
}

function digitAtToken(ctx: Ctx, station: TokenStation, digits: string, num: NodeJson): EditingState {
  const { node, ref, offset } = station;
  const text = tokenText(node);
  if (node.type === 'sym') {
    // Digit-glue: digits are symbol-name characters wherever letters exist
    // to their left; before letters (offset 0) a digit starts a number.
    if (offset > 0 && !ctx.flagged) {
      return growLeft(ctx, { node, path: station.path }, symFromText(text.slice(0, offset) + digits + text.slice(offset)));
    }
    return juxtaposeToken(ctx, station, num, offset === 0 ? 'before' : 'after');
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
      return apply1(ctx, { op: 'insert', node: sym, at: posOf(station.ref) });
    case 'tok':
      return letterAtToken(ctx, station, letters, sym);
    case 'after':
      return place(ctx, implicitPair(station.node, sym), replacePosOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 2,
      });
    case 'seam': {
      const seam = seamOf(ctx.env, station);
      // 0. a pending null takes the leaf (S-003's leading flow, or a right
      //    edge waiting for its first operand).
      const filled = seamPendingFill(ctx, station, seam, sym, (path) => ({ kind: 'node', path }));
      if (filled !== null) return filled;
      // 1. glue into the right symbol's front (N2).
      if (seam.right !== null && seam.right.node !== null && seam.right.node.type === 'sym' && !ctx.flagged) {
        return glueFront(ctx, seam.right, letters);
      }
      // 2. glue onto the left symbol (behind — T3's "front or behind").
      if (seam.left !== null && seam.left.node !== null && seam.left.node.type === 'sym' && !ctx.flagged) {
        return growLeft(ctx, seam.left, symFromText(tokenText(seam.left.node) + letters));
      }
      // 3/4. juxtapose onto the right / left cell (letters never merge with
      // numbers: S-032's juxtaposed symbol; symbol-before-X refuses at
      // evaluation — the ruling annotation, not a typing restriction).
      if (seam.right !== null && seam.right.node !== null) {
        return place(ctx, implicitPair(sym, seam.right.node), replacePosOf(refOfPath(seam.right.path)), {
          kind: 'row', path: seam.right.path, index: 1,
        });
      }
      if (seam.left !== null && seam.left.node !== null) {
        return place(ctx, implicitPair(seam.left.node, sym), replacePosOf(refOfPath(seam.left.path)), {
          kind: 'row', path: seam.left.path, index: 2,
        });
      }
      return place(ctx, sym, { at: 'row', path: station.path, index: station.index }, {
        kind: 'row', path: station.path, index: station.index + 1,
      });
    }
  }
}

function letterAtToken(ctx: Ctx, station: TokenStation, letters: string, sym: NodeJson): EditingState {
  const { node, ref, offset } = station;
  const text = tokenText(node);
  if (node.type === 'sym') {
    if (!ctx.flagged) {
      const glued = symFromText(text.slice(0, offset) + letters + text.slice(offset));
      return apply1(ctx, { op: 'insert', node: glued, at: replacePosOf(ref) });
    }
    return juxtaposeToken(ctx, station, sym, offset === 0 ? 'before' : 'after');
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
      const text = tokenText(node);
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
      return place(ctx, implicitPair(station.node, dotted), replacePosOf(station.ref), {
        kind: 'token', path: [...pathOf(station.ref), 1], index: 2,
      });
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
      const text = tokenText(node);
      const at = replacePosOf(ref);
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
            kind: 'row', path: ref.path, index: ref.index + 1,
          });
        }
      }
      return place(ctx, opRow(fn, [left, right]), at, { kind: 'row', path: pathOf(ref), index: 1 });
    }
    case 'after':
      return place(ctx, opRow(fn, [station.node, null]), replacePosOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 1,
      });
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
      return juxtaposeToken(ctx, station, group, offset === 0 ? 'before' : offset === tokenText(node).length ? 'after' : 'split');
    }
    case 'after':
      return place(ctx, implicitPair(station.node, groupJson(null, true)), replacePosOf(station.ref), {
        kind: 'slot', path: [...pathOf(station.ref), 1], slot: 'child',
      });
    case 'seam': {
      const seam = seamOf(ctx.env, station);
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
      return juxtaposeToken(ctx, station, fence, station.offset === 0 ? 'before' : station.offset === tokenText(station.node).length ? 'after' : 'split');
    case 'after':
      return place(ctx, implicitPair(station.node, fence), replacePosOf(station.ref), {
        kind: 'row', path: pathOf(station.ref), index: 2,
      });
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
      const text = tokenText(node);
      if (offset > 0 && offset < text.length) {
        // Inside a token: split it into two glyph-less adjacent nodes —
        // two symbols (S-021's same-type state) or S-098's forced
        // number-number adjacency (the editing state; refuses evaluation).
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
      const text = tokenText(node);
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
      return place(ctx, mk(station.node, null), replacePosOf(station.ref), {
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
