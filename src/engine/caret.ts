// Caret geography: paths into the tree and the caret as a pure data value.
//
// The spec owns the representation decision: "Caret = path into the tree
// (node + index), owned by the editing engine; no UIDs, no caret state in
// JSON." A path is a list of steps from the root — a numeric step indexes an
// n-ary args row (op/fn), a string step names a fixed-arity slot by its JSON
// field name. Everything here works on the JSON envelope (NodeJson), not on
// node class instances: the reducer transforms envelopes and validates here,
// so no second tree-walking implementation ever duplicates fromJSON's parse.

import type { Envelope, NodeJson } from '../ast/json.js';

/** Fixed-arity child slots by their JSON field name. */
export type SlotName = 'child' | 'num' | 'den' | 'base' | 'exp' | 'radicand' | 'index' | 'value';

/** One step down the tree: an args-row index (number) or a slot name (string). */
export type Step = number | SlotName;

/** Path from the root to a node. `[]` is the root node itself. */
export type Path = readonly Step[];

/** Which slots each node type owns. A slot name only addresses a node of the
 *  owning type — `frac.num` is valid on a frac, never on a pow. */
const SLOTS: Readonly<Record<NodeJson['type'], readonly SlotName[]>> = {
  num: [],
  sym: [],
  op: [],
  fn: [],
  group: ['child'],
  frac: ['num', 'den'],
  pow: ['base', 'exp'],
  root: ['radicand', 'index'],
  sub: [],
  unit: ['value'],
  fence: [], // a close-fence glyph token is a leaf (session 1, additive)
};

/**
 * The caret, as engine-owned data:
 * - `empty`   — the whole formula is empty (root null); the one defined
 *               empty-formula caret state.
 * - `node`    — on the node at `path` (leaf or container, `[]` = root). For a
 *               num/sym leaf it reads as the token's right edge (the station
 *               a token's continued typing continues from).
 *               Additive `side` (rework session 4a, owner-ruled 2026-11-09):
 *               the whole-structure BORDER station of a lone container —
 *               `side: 'left'` = the position before the structure's extent,
 *               `side: 'right'` = after it (the outside station D5 fires
 *               from). Valid only on fenced/fenceless containers
 *               (group/fn/frac/pow/root): a lone token's edges ARE its
 *               in-token ends, and rows carry seams, so guarding them out
 *               keeps one state per visual spot (OA-visual-trumps). Produced
 *               only when the movement climb exhausts at a bare non-row
 *               root; never serialized.
 * - `slot`    — in an empty fixed slot of the node at `path`.
 * - `row`     — insertion point into an args row: index 0..args.length
 *               (args.length = after the last arg). A null entry in a row is
 *               not addressed by this — it is an empty slot like any other,
 *               addressed structurally by index when an op targets it.
 * - `token`   — inside a text-like token: on the node at `path`, at character
 *               offset `index` (0..len of the addressed text). Numbers and
 *               symbols (rework session 2a, T3 glue/split at any caret offset;
 *               the trailing decimal dot of a `dot`-flagged number is part of
 *               the text). Rework session 2b-2 (S-104): a unit's LABEL is
 *               letter-wise addressable exactly like a symbol name — attached
 *               units are granular. A `sub` node's two label strings are
 *               addressable one at a time (T9 vocabulary ruling, 2026-11-09):
 *               a token caret on a `sub` carries `label` choosing the string
 *               `index` addresses ('base' | 'sub' — additive field, present
 *               exactly for sub nodes; its absence addresses the plain token
 *               text of num/sym/unit). Function heads stay atomic.
 * - `boundary` — pure additive flag (on every non-empty kind): armed by the
 *               Space key at a token edge (S-021/S-022); the NEXT same-type
 *               input starts a new node instead of gluing; no visible mark,
 *               never serialized. Any caret relocation or movement produces
 *               fresh carets without the flag, disarming it.
 */
export interface CaretBoundary {
  readonly boundary?: true;
}

/** Which of a `sub` node's two label strings a token caret addresses
 *  (T9 vocabulary ruling — required exactly on sub nodes). */
export type SubLabel = 'base' | 'sub';

/** The whole-structure border sides of a lone container's node caret
 *  (rework session 4a, additive — `before` reads as left in JSON). */
export type NodeSide = 'left' | 'right';

export type Caret =
  | ({ readonly kind: 'empty' } & CaretBoundary)
  | ({ readonly kind: 'node'; readonly path: Path; readonly side?: NodeSide } & CaretBoundary)
  | ({ readonly kind: 'slot'; readonly path: Path; readonly slot: SlotName } & CaretBoundary)
  | ({ readonly kind: 'row'; readonly path: Path; readonly index: number } & CaretBoundary)
  | ({ readonly kind: 'token'; readonly path: Path; readonly index: number; readonly label?: SubLabel } & CaretBoundary);

/**
 * The rendered text of a number or symbol token (what the editor shows and
 * what the in-token offset addresses). A `dot`-flagged number's trailing
 * decimal point is part of the text (`5.` has length 2). A unit's text is its
 * LABEL string (S-104: attached units are granular — the label is addressed
 * exactly like a symbol name). A `sub` node's text depends on which label a
 * specific caret carries — see `subLabelText`; plain `tokenText` does not
 * address sub. Everything else is not an in-token token (0).
 */
export function tokenText(node: NodeJson): string {
  if (node.type === 'num') return String(node.value) + ((node as { dot?: boolean }).dot === true ? '.' : '');
  if (node.type === 'sym') return node.name;
  if (node.type === 'unit') return node.unit;
  return '';
}

/** The one sub label string a token caret addresses (T9): the caret's
 *  `label` field selects it; it is required on sub nodes. */
export function subLabelText(node: NodeJson, label: SubLabel): string {
  if (node.type !== 'sub') return '';
  return label === 'base' ? (node as { base: string }).base : (node as { sub: string }).sub;
}

/** True iff the node is a text-like in-token token (num, sym, or — since
 *  S-104 — a unit, whose label is the addressed text). Sub labels are
 *  addressed caret-wise, not by this predicate. */
export function isTokenNode(node: NodeJson): boolean {
  return node.type === 'num' || node.type === 'sym' || node.type === 'unit';
}

// ——— Refs: where content sits or will land (the envelope-level analog of a
// caret, used by the policy layers to address insertion/swap targets) ———

/** Where content sits or will land: the root, a fixed slot, an args cell. */
export type Ref =
  | { readonly at: 'root' }
  | { readonly at: 'slot'; readonly path: Path; readonly slot: SlotName }
  | { readonly at: 'cell'; readonly path: Path; readonly index: number };

/** The ref of the node at `path` (its container position in the envelope). */
export function refOfPath(path: Path): Ref {
  if (path.length === 0) return { at: 'root' };
  const step = path[path.length - 1];
  return typeof step === 'number'
    ? { at: 'cell', path: path.slice(0, -1), index: step }
    : { at: 'slot', path: path.slice(0, -1), slot: step };
}

/** The absolute path a ref addresses. */
export function pathOfRef(ref: Ref): Path {
  switch (ref.at) {
    case 'root':
      return [];
    case 'slot':
      return [...ref.path, ref.slot];
    case 'cell':
      return [...ref.path, ref.index];
  }
}

// ——— JSON-level resolution (NodeJson, never node instances) ———

type JsonRecord = Record<string, unknown> & { type: NodeJson['type'] };

/** The fixed slots a node type owns, in declaration order. */
export function slotsOf(node: NodeJson): readonly SlotName[] {
  return SLOTS[node.type];
}

/** True iff `node` owns the given slot. */
export function hasSlot(node: NodeJson, slot: SlotName): boolean {
  return slotsOf(node).includes(slot);
}

/** Slot content: undefined and null are the same empty slot (the spec's
 *  empty-slot rule — root.index omitted = null = square root). */
export function slotValue(node: NodeJson, slot: SlotName): NodeJson | null {
  const value = (node as JsonRecord)[slot];
  return value === undefined || value === null ? null : (value as NodeJson);
}

/** Set a slot's content on a JSON node (working copy only — envelopes handed
 *  to the reducer are fresh clones the reducer owns). */
export function setSlot(node: NodeJson, slot: SlotName, content: NodeJson | null): void {
  (node as JsonRecord)[slot] = content;
}

/** True iff the node is an n-ary row container (op or fn). */
export function isRowNode(node: NodeJson): boolean {
  return node.type === 'op' || node.type === 'fn';
}

/** The args row of an op/fn node, as a mutable array (working copy). */
export function rowArgs(node: NodeJson): (NodeJson | null)[] {
  const args = (node as JsonRecord).args;
  if (!Array.isArray(args)) {
    throw new Error('engine: row node without args array (fromJSON output always has one)');
  }
  return args as (NodeJson | null)[];
}

/** Resolve a path against an envelope. Null when any step leaves the tree —
 *  a node that is not a row container, an out-of-range index, an unowned
 *  slot, or a null slot along the way. */
export function nodeAt(env: Envelope, path: Path): NodeJson | null {
  let current: NodeJson | null = env.root;
  for (const step of path) {
    if (current === null) return null;
    if (typeof step === 'number') {
      if (!isRowNode(current)) return null;
      const args = (current as JsonRecord).args as (NodeJson | null)[] | undefined;
      if (!Array.isArray(args) || step < 0 || step >= args.length) return null;
      current = args[step] ?? null;
    } else {
      if (!hasSlot(current, step)) return null;
      current = slotValue(current, step);
    }
  }
  return current;
}

/** True iff the caret resolves to a real position in this tree (or the
 *  defined empty-formula state when the tree is empty). `empty` is valid iff
 *  the root is null; no other caret kind is valid then. */
export function caretResolvesIn(env: Envelope, caret: Caret): boolean {
  switch (caret.kind) {
    case 'empty':
      return env.root === null;
    case 'node': {
      const node = nodeAt(env, caret.path);
      if (node === null) return false;
      // The additive border side (4a): guarded to whole containers whose
      // extent exceeds their content ends — group/fn (fenced) and
      // frac/pow/root (fenceless 2D). Tokens are addressed in-token, rows
      // carry their own seams, and sub/unit label ends coincide with their
      // extents: a side there would duplicate an existing state's spot.
      if (caret.side !== undefined) {
        const t = node.type;
        return t === 'group' || t === 'fn' || t === 'frac' || t === 'pow' || t === 'root';
      }
      return true;
    }
    case 'slot': {
      const parent = nodeAt(env, caret.path);
      return parent !== null && hasSlot(parent, caret.slot) && slotValue(parent, caret.slot) === null;
    }
    case 'row': {
      const parent = nodeAt(env, caret.path);
      if (parent === null || !isRowNode(parent)) return false;
      const args = (parent as JsonRecord).args as unknown;
      if (!Array.isArray(args)) return false;
      return caret.index >= 0 && caret.index <= args.length;
    }
    case 'token': {
      const node = nodeAt(env, caret.path);
      if (node === null) return false;
      if (node.type === 'sub') {
        // Sub labels are addressed one at a time (T9): the `label` field is
        // required here and forbidden everywhere else.
        if (caret.label !== 'base' && caret.label !== 'sub') return false;
        const len = subLabelText(node, caret.label).length;
        return Number.isInteger(caret.index) && caret.index >= 0 && caret.index <= len;
      }
      if (caret.label !== undefined) return false;
      if (!isTokenNode(node)) return false;
      return Number.isInteger(caret.index) && caret.index >= 0 && caret.index <= tokenText(node).length;
    }
  }
}

// ——— Splice adjustment ———
//
// When an args row splices (insert at index i / delete at index i) every
// position addressed through that row shifts with it. Without adjustment a
// caret that pointed at arg n would silently end up addressing a different
// node after the splice — validity alone would not catch it. The rule:
// coordinates in the spliced row's address space move with the splice; a
// position that lived inside the deleted arg falls back to the seam (the
// insertion point where the removal happened).

const samePrefix = (path: Path, prefix: Path): boolean =>
  prefix.length <= path.length && prefix.every((step, i) => step === path[i]);

/** The path a caret addresses a node through: the node itself for `node`, the
 *  owning parent for `slot`, the row container for `row` (empty: no node at
 *  all). Shared with ops.ts, whose removal fallbacks ask "was whatever the
 *  caret pointed at inside this subtree?" */
export function entryPath(caret: Caret): Path {
  switch (caret.kind) {
    case 'empty':
      return [];
    case 'node':
    case 'slot':
    case 'row':
    case 'token':
      return caret.path;
  }
}

/** Numeric step by which a caret's address enters the spliced row, or null
 *  when it does not pass through the row's coordinate space. */
function throughRow(entry: Path, row: Path): number | null {
  if (entry.length <= row.length || !samePrefix(entry, row)) return null;
  const step = entry[row.length];
  return typeof step === 'number' ? step : null;
}

/** Rebuild a caret with the numeric step at `depth` of its path replaced. */
function withStep(caret: Caret, depth: number, step: number): Caret {
  switch (caret.kind) {
    case 'empty':
      throw new Error('engine: empty caret cannot pass through a row');
    case 'node':
    case 'slot':
    case 'row':
    case 'token': {
      const path = [...caret.path];
      path[depth] = step;
      return { ...caret, path };
    }
  }
}

/**
 * Adjust a caret for a splice (insert: delta +1, delete: delta -1) of the
 * args row at `row`, index `i`. Positions addressed through the row shift
 * with the splice; anything inside a deleted arg falls back to the seam
 * (row insertion point at the removal position). Carets that survive
 * byte-identically are returned as-is (reference-stable, never rebuilt).
 */
export function adjustRowCaret(caret: Caret, row: Path, i: number, delta: -1 | 1): Caret {
  const entry = entryPath(caret);
  const n = throughRow(entry, row);
  if (n === null) {
    // The address does not pass through the spliced row. Only a row caret
    // ON the row itself (container == row) still lives in its coordinate.
    if (caret.kind === 'row' && caret.path.length === row.length && samePrefix(caret.path, row)) {
      const m = caret.index;
      if (delta === 1) return m >= i ? { ...caret, index: m + 1 } : caret;
      // deleting index i: before it stays, at/after it moves down; a caret
      // exactly at the seam stays (the seam index remains in range — i was
      // a valid arg index, so i <= length-1 still holds after removal).
      return m > i ? { ...caret, index: m - 1 } : caret;
    }
    return caret;
  }
  // The address enters the row at numeric step n.
  if (delta === 1) {
    return n >= i ? withStep(caret, row.length, n + 1) : caret;
  }
  if (n > i) return withStep(caret, row.length, n - 1);
  if (n < i) return caret;
  // n === i: the whole address (at any depth) lived inside the deleted arg.
  return { kind: 'row', path: row, index: i };
}
