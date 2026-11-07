// Visual-test case catalog (DOM-layer arc session 5) — DEV-ONLY seed data for the
// demo case browser. Not part of the published package (package.json exports/files
// pin that). The same catalog can later feed regression tests.
//
// Every case is a defined starting state: a seed envelope (legal through fromJSON,
// including incomplete trees) plus a seed caret that resolves in it (checked by
// tests/demo-case-catalog.test.ts). Instruction cases (keys) seed the EMPTY formula
// and carry the typed key sequence — the instruction is the seed.
//
// NO expected-behavior annotations anywhere in this file (session close-out: the
// live check falsified the interaction model the earlier annotations encoded).
// Each case carries only: ID, category, label (the seed formula in words), seed
// envelope, seed caret, and a one-line `stress` note saying what the case stresses
// and what action to perform — never what the editor is expected to do. Expected
// behavior comes from a separate owner-authored spec, not from this repo.
//
// ID scheme: <CATEGORY>-<NN>, zero-padded, stable — struck IDs are retired, never
// reused. The globally FIRST case (E-01) is the empty starting point.

import type { Envelope, NodeJson } from '../src/ast/index.js';
import type { Caret, Path, SlotName } from '../src/engine/index.js';

export interface CatalogCategory {
  readonly key: string;
  readonly title: string;
}

export interface CatalogCase {
  /** Stable ID: `<category>-<NN>`. */
  readonly id: string;
  /** Category key (must be declared in CATEGORIES). */
  readonly category: string;
  /** Display label: the seed formula / scenario in words (no outcomes). */
  readonly label: string;
  /** One line: what this case stresses + the action to perform (no outcomes). */
  readonly stress: string;
  /** Seed AST (envelope v1). */
  readonly envelope: Envelope;
  /** Seed caret — must resolve in the seed envelope. */
  readonly caret: Caret;
  /** Typed-from-empty instruction (instruction cases only; the seed is empty). */
  readonly keys?: string;
}

// ——— compact node builders (dev-only) ———

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const op = (name: string, ...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: name, args });
const fn = (name: string, ...args: (NodeJson | null)[]): NodeJson => ({ type: 'fn', name, args });
const group = (child: NodeJson | null): NodeJson => ({ type: 'group', parens: 'always', child });
const frac = (n: NodeJson | null, d: NodeJson | null): NodeJson => ({ type: 'frac', num: n, den: d });
const pow = (b: NodeJson | null, e: NodeJson | null): NodeJson => ({ type: 'pow', base: b, exp: e });
const root = (radicand: NodeJson | null, index?: NodeJson | null): NodeJson =>
  index == null ? { type: 'root', radicand } : { type: 'root', radicand, index };
const sub = (base: string, s: string): NodeJson => ({ type: 'sub', base, sub: s });
const unit = (value: NodeJson | null, u: string): NodeJson => ({ type: 'unit', value, unit: u });

const EMPTY_ENV: Envelope = { v: 1, root: null };
const env = (rootNode: NodeJson | null): Envelope => ({ v: 1, root: rootNode });

// ——— caret builders ———

const EMPTY: Caret = { kind: 'empty' };
const nd = (path: Path): Caret => ({ kind: 'node', path });
const rw = (path: Path, index: number): Caret => ({ kind: 'row', path, index });
const sl = (path: Path, slot: SlotName): Caret => ({ kind: 'slot', path, slot });
const tk = (path: Path, index: number): Caret => ({ kind: 'token', path, index });

// ——— categories (display order; E first so the globally first case is E-01) ———

export const CATEGORIES: readonly CatalogCategory[] = [
  { key: 'E', title: 'Entry states (empty + freshly typed)' },
  { key: 'N', title: 'Node types alone (all 10) + stressed variants' },
  { key: 'X', title: 'Nesting combinations' },
  { key: 'C', title: 'Caret-reachability classes' },
  { key: 'T', title: 'Typing from empty (instruction cases)' },
  { key: 'I', title: 'Insertion at position classes' },
  { key: 'S', title: 'Operator swap at mid-row positions' },
  { key: 'B', title: 'Backspace (peel / atomic / guard / structure death / Ctrl)' },
  { key: 'M', title: 'Navigation (horizontal + vertical with memory)' },
  { key: 'K', title: 'Click placement' },
  { key: 'U', title: 'Undo/redo walk-backs' },
  { key: 'R', title: 'Real-world formulas (typed + prebuilt to edit)' },
  { key: 'P', title: 'Known-suspect probes' },
];

// ——— the catalog ———

export const CASES: readonly CatalogCase[] = [
  // ——— E: entry states ———
  {
    id: 'E-01',
    category: 'E',
    label: 'empty formula',
    stress: 'The empty starting point — type `5+3`, arrows, Backspace, click the background.',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'E-02',
    category: 'E',
    label: '5 (freshly typed single digit)',
    stress: 'Single number leaf at root — type `7`, Backspace, Left/Right.',
    envelope: env(num(5)),
    caret: nd([]),
  },

  // ——— N: node types alone + stressed variants ———
  {
    id: 'N-01',
    category: 'N',
    label: '42 (number alone)',
    stress: 'Number leaf with an in-token caret at offset 1 — Left/Right inside the token, type `+` at the offset, Ctrl+Backspace.',
    envelope: env(num(42)),
    caret: tk([], 1),
  },
  {
    id: 'N-02',
    category: 'N',
    label: 'x (symbol alone)',
    stress: 'Symbol leaf at root — type `a`, click the glyph, Backspace.',
    envelope: env(sym('x')),
    caret: nd([]),
  },
  {
    id: 'N-03',
    category: 'N',
    label: 'a + b (binary op row)',
    stress: 'Op row, caret on the interior seam (the `+` glyph position) — type `*`, arrows across, click the `+` separator mo.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: rw([], 1),
  },
  {
    id: 'N-04',
    category: 'N',
    label: 'a + b + c (n-ary chain)',
    stress: 'Flat n-ary row, caret on the last interior seam — type `+`, Backspace at the seam.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 2),
  },
  {
    id: 'N-05',
    category: 'N',
    label: '−x (unary op row)',
    stress: 'Unary op row, caret after the operand — type `+`, Backspace twice.',
    envelope: env(op('unaryMinus', sym('x'))),
    caret: rw([], 1),
  },
  {
    id: 'N-06',
    category: 'N',
    label: 'sin(x, 0.5) (two-arg function)',
    stress: 'Function row with a comma separator, caret on the seam — click the comma mo, type `+` at the seam, Left/Right through the cells.',
    envelope: env(fn('sin', sym('x'), num(0.5))),
    caret: rw([], 1),
  },
  {
    id: 'N-07',
    category: 'N',
    label: '(a + b) (group alone)',
    stress: 'Group with a flat row child, caret on the group — type `)`, Left/Right, click the right edge zone of the group.',
    envelope: env(group(op('add', sym('a'), sym('b')))),
    caret: nd([]),
  },
  {
    id: 'N-08',
    category: 'N',
    label: 'a/b (fraction alone)',
    stress: 'Fraction, caret in the numerator — Down, Up, Left/Right, click the mfrac halves.',
    envelope: env(frac(sym('a'), sym('b'))),
    caret: nd(['num']),
  },
  {
    id: 'N-09',
    category: 'N',
    label: 'x² (power alone)',
    stress: 'Power, caret in the base — Right, Left, Up, Down.',
    envelope: env(pow(sym('x'), num(2))),
    caret: nd(['base']),
  },
  {
    id: 'N-10',
    category: 'N',
    label: '√x (square root alone)',
    stress: 'Square root (no index in the tree), caret in the radicand — Up, Right, Backspace.',
    envelope: env(root(sym('x'))),
    caret: nd(['radicand']),
  },
  {
    id: 'N-11',
    category: 'N',
    label: '³√x (indexed root)',
    stress: 'Root with an index, caret in the index — Down, Up, Left/Right, click the index.',
    envelope: env(root(sym('x'), num(3))),
    caret: nd(['index']),
  },
  {
    id: 'N-12',
    category: 'N',
    label: 'x_max (subscript alone)',
    stress: 'Subscript leaf at root — arrows, Backspace, click the msub.',
    envelope: env(sub('x', 'max')),
    caret: nd([]),
  },
  {
    id: 'N-13',
    category: 'N',
    label: '50 mm (unit alone)',
    stress: 'Unit, caret in the value — click the upright mm symbol, Right, Backspace on the value.',
    envelope: env(unit(num(50), 'mm')),
    caret: nd(['value']),
  },
  {
    id: 'N-14',
    category: 'N',
    label: '(a/b) m (unit on a complex operand)',
    stress: 'Unit wrapping a fraction, caret in the value’s numerator — Down, click the upright unit symbol.',
    envelope: env(unit(frac(sym('a'), sym('b')), 'm')),
    caret: nd(['value', 'num']),
  },
  {
    id: 'N-15',
    category: 'N',
    label: 'a + □ (row with a pending empty cell)',
    stress: 'Op row with a null cell, caret in the cell — type `b`, Backspace, Ctrl+Backspace.',
    envelope: env(op('add', sym('a'), null)),
    caret: rw([], 1),
  },

  // ——— X: nesting combinations ———
  {
    id: 'X-01',
    category: 'X',
    label: '(a/b)/c (fraction inside fraction)',
    stress: 'Two stacked fraction levels, caret on the inner fraction — Down ×2, Up ×2, click the inner mfrac edge zone.',
    envelope: env(frac(frac(sym('a'), sym('b')), sym('c'))),
    caret: nd(['num']),
  },
  {
    id: 'X-02',
    category: 'X',
    label: '((a+b) + x)/y (group in a row inside a fraction)',
    stress: 'Group as a row operand inside a numerator, caret on the seam — type `*` at the seam, Left, Down.',
    envelope: env(frac(op('add', group(op('add', sym('a'), sym('b'))), sym('x')), sym('y'))),
    caret: rw(['num'], 1),
  },
  {
    id: 'X-03',
    category: 'X',
    label: 'sin(x)² (function inside a power)',
    stress: 'Function row as a power base, caret on the base — Right, Up, Left into the fn args.',
    envelope: env(pow(fn('sin', sym('x')), num(2))),
    caret: nd(['base']),
  },
  {
    id: 'X-04',
    category: 'X',
    label: 'x^(2^3) (power inside power)',
    stress: 'Nested power in the exponent, caret on the inner power — Down, click the exp msup.',
    envelope: env(pow(sym('x'), pow(num(2), num(3)))),
    caret: nd(['exp']),
  },

  // ——— C: caret-reachability classes ———
  {
    id: 'C-01',
    category: 'C',
    label: 'a + b, row start seam (index 0)',
    stress: 'Row start seam — Left, Backspace, Right.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: rw([], 0),
  },
  {
    id: 'C-02',
    category: 'C',
    label: 'a + b + c, interior seam (index 1)',
    stress: 'Interior seam over the first `+` glyph — arrows, type `−` at the seam.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 1),
  },
  {
    id: 'C-03',
    category: 'C',
    label: 'a + b, row end seam (index 2)',
    stress: 'Filled end seam after the last operand — Right, type `^`, type `+`.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: rw([], 2),
  },
  {
    id: 'C-04',
    category: 'C',
    label: '123 + b, in-token caret at offset 2',
    stress: 'In-token caret mid-number — Left, type `+` (structure token at an interior offset), type `7`.',
    envelope: env(op('add', num(123), sym('b'))),
    caret: tk([0], 2),
  },
  {
    id: 'C-05',
    category: 'C',
    label: 'a/□, slot placeholder caret in the denominator',
    stress: 'Empty slot (□) caret — type `5`, Backspace, click the □.',
    envelope: env(frac(sym('a'), null)),
    caret: sl([], 'den'),
  },
  {
    id: 'C-06',
    category: 'C',
    label: 'a + □, caret on the row container itself',
    stress: 'Self-on-container caret on a row with a pending cell — type `+`, Left/Right.',
    envelope: env(op('add', sym('a'), null)),
    caret: nd([]),
  },

  // ——— T: typing from empty (instruction cases; seed = empty formula) ———
  {
    id: 'T-01',
    category: 'T',
    label: 'type `5+3*2` from empty',
    stress: 'Typed-from-empty sequence: digit, `+`, digit, `*` (higher-precedence operator last), digit.',
    keys: '5+3*2',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'T-02',
    category: 'T',
    label: 'type `a/b^c` from empty',
    stress: 'Typed-from-empty sequence: `/` then `^` (structure tokens in a row).',
    keys: 'a/b^c',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'T-03',
    category: 'T',
    label: 'type `(a+b)*c` from empty',
    stress: 'Typed-from-empty sequence: group open, row inside, group close, `*`, operand.',
    keys: '(a+b)*c',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'T-04',
    category: 'T',
    label: 'type `-x+2` from empty',
    stress: 'Typed-from-empty sequence: `-` as the very first token, then letter, `+`, digit.',
    keys: '-x+2',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'T-05',
    category: 'T',
    label: 'type `x^2^3` from empty',
    stress: 'Typed-from-empty sequence: `^` typed twice in a row.',
    keys: 'x^2^3',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'T-06',
    category: 'T',
    label: 'type `2*3+4` from empty',
    stress: 'Typed-from-empty sequence: `*` first, then `+` (lower-precedence operator last).',
    keys: '2*3+4',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },

  // ——— I: insertion at position classes ———
  {
    id: 'I-01',
    category: 'I',
    label: '□/b, caret in the empty numerator slot',
    stress: 'Empty fixed slot — type `5`.',
    envelope: env(frac(null, sym('b'))),
    caret: sl([], 'num'),
  },
  {
    id: 'I-02',
    category: 'I',
    label: 'a + □, caret in the null row cell',
    stress: 'Null args cell — type `b`.',
    envelope: env(op('add', sym('a'), null)),
    caret: rw([], 1),
  },
  {
    id: 'I-03',
    category: 'I',
    label: 'x + 5, end seam after the trailing number',
    stress: 'Filled end seam after a number operand — type `6`.',
    envelope: env(op('add', sym('x'), num(5))),
    caret: rw([], 2),
  },
  {
    id: 'I-04',
    category: 'I',
    label: 'a + □, caret in the null row cell (operators)',
    stress: 'Operand-expected cell — type `*`, then `-`.',
    envelope: env(op('add', sym('a'), null)),
    caret: rw([], 1),
  },
  {
    id: 'I-05',
    category: 'I',
    label: 'a + b, caret on b (last operand)',
    stress: 'Held last operand — type `(`, then `)`.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: nd([1]),
  },
  {
    id: 'I-06',
    category: 'I',
    label: 'a/b, caret on the numerator',
    stress: 'Left side of a fraction (numerator slot) — type `/`.',
    envelope: env(frac(sym('a'), sym('b'))),
    caret: nd(['num']),
  },

  // ——— S: operator token at mid-row positions ———
  {
    id: 'S-01',
    category: 'S',
    label: 'a + b×c, seam on the +',
    stress: 'Mid-row seam in a mixed-precedence row — type `*` at the seam.',
    envelope: env(op('add', sym('a'), op('multiply', sym('b'), sym('c')))),
    caret: rw([], 1),
  },
  {
    id: 'S-02',
    category: 'S',
    label: 'a×(b + c), seam on the ×',
    stress: 'Mid-row seam with a nested row as the right operand — type `+` at the seam.',
    envelope: env(op('multiply', sym('a'), op('add', sym('b'), sym('c')))),
    caret: rw([], 1),
  },
  {
    id: 'S-03',
    category: 'S',
    label: 'a + b + c, seam on the first + (same operator retyped)',
    stress: 'Mid-row seam — type `+` at the seam (the same operator), then Ctrl+Z.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 1),
  },
  {
    id: 'S-04',
    category: 'S',
    label: 'a + b + c, seam on the second +',
    stress: 'Second seam of a 3-operand row — type `*` at seam 2.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 2),
  },
  {
    id: 'S-05',
    category: 'S',
    label: 'a + b + c, caret on b (mid-row operand)',
    stress: 'Node caret on a mid-row operand — type `-` while standing on b.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: nd([1]),
  },
  {
    id: 'S-06',
    category: 'S',
    label: 'a + b, seam on the + (structure token)',
    stress: 'Mid-row seam — type `/` at the seam.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: rw([], 1),
  },
  {
    id: 'S-07',
    category: 'S',
    label: 'a×b, caret on a (first operand, structure token)',
    stress: 'Node caret on the first operand — type `^` while standing on a.',
    envelope: env(op('multiply', sym('a'), sym('b'))),
    caret: nd([0]),
  },

  // ——— B: backspace ———
  {
    id: 'B-01',
    category: 'B',
    label: '123 alone, caret on the number',
    stress: 'Number at root — Backspace ×3.',
    envelope: env(num(123)),
    caret: nd([]),
  },
  {
    id: 'B-02',
    category: 'B',
    label: '123 + b, in-token caret at offset 2',
    stress: 'In-token caret — Backspace at offset 2.',
    envelope: env(op('add', num(123), sym('b'))),
    caret: tk([0], 2),
  },
  {
    id: 'B-03',
    category: 'B',
    label: 'x + y, end seam',
    stress: 'End seam with a node left of it — Backspace.',
    envelope: env(op('add', sym('x'), sym('y'))),
    caret: rw([], 2),
  },
  {
    id: 'B-04',
    category: 'B',
    label: 'a/□, caret in the denominator placeholder',
    stress: 'Fraction with one empty slot — Backspace at the placeholder, then on the numerator, then again.',
    envelope: env(frac(sym('a'), null)),
    caret: sl([], 'den'),
  },
  {
    id: 'B-05',
    category: 'B',
    label: '+□ (all-empty op row), caret in the cell',
    stress: 'Op row whose only cell is empty — Backspace in the cell.',
    envelope: env(op('add', null)),
    caret: rw([], 0),
  },
  {
    id: 'B-06',
    category: 'B',
    label: '123 + b, in-token caret at offset 1',
    stress: 'Ctrl+Backspace inside a number token.',
    envelope: env(op('add', num(123), sym('b'))),
    caret: tk([0], 1),
  },
  {
    id: 'B-07',
    category: 'B',
    label: 'x², caret on the base',
    stress: 'Slot content node — Ctrl+Backspace, then Backspace at the base slot.',
    envelope: env(pow(sym('x'), num(2))),
    caret: nd(['base']),
  },

  // ——— M: navigation (horizontal + vertical) ———
  {
    id: 'M-01',
    category: 'M',
    label: 'a + b×c + d, caret on a',
    stress: 'Horizontal walk across a row containing a nested row — Right ×4, then Left ×4.',
    envelope: env(op('add', sym('a'), op('multiply', sym('b'), sym('c')), sym('d'))),
    caret: nd([0]),
  },
  {
    id: 'M-02',
    category: 'M',
    label: '(x+y)/(c+d), caret on x',
    stress: 'Vertical move between fraction slots with horizontal moves in between — Down, Left, Left, Up.',
    envelope: env(frac(op('add', sym('x'), sym('y')), op('add', sym('c'), sym('d')))),
    caret: nd(['num', 0]),
  },
  {
    id: 'M-03',
    category: 'M',
    label: '(12+x)/(3+y), in-token caret at offset 1 in the numerator number',
    stress: 'Vertical move with an in-token origin — Down, Left, Left, Up.',
    envelope: env(frac(op('add', num(12), sym('x')), op('add', num(3), sym('y')))),
    caret: tk(['num', 0], 1),
  },
  {
    id: 'M-04',
    category: 'M',
    label: '(x+y)², caret after y in the base row',
    stress: 'Power with a row base — Right, Left, Up, Down around the base/exp edge.',
    envelope: env(pow(op('add', sym('x'), sym('y')), num(2))),
    caret: nd(['base', 1]),
  },
  {
    id: 'M-05',
    category: 'M',
    label: '³√(a+b), caret after b in the radicand row',
    stress: 'Indexed root — Up, Down between the radicand and index regions.',
    envelope: env(root(op('add', sym('a'), sym('b')), num(3))),
    caret: nd(['radicand', 1]),
  },
  {
    id: 'M-06',
    category: 'M',
    label: '(x²)/y, caret on the exponent',
    stress: 'Vertical move out of a power nested in a fraction numerator — Down, Down.',
    envelope: env(frac(pow(sym('x'), num(2)), sym('y'))),
    caret: nd(['num', 'exp']),
  },

  // ——— K: click placement (seed + precise click target in `stress`) ———
  {
    id: 'K-01',
    category: 'K',
    label: 'a + b — background clicks',
    stress: 'Click the math background at fractions 0.04 / 0.4 / 0.6 / 0.96 of the math extent.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: nd([]),
  },
  {
    id: 'K-02',
    category: 'K',
    label: '(a+b) + c — group container clicks',
    stress: 'Click the group mrow at fractions 0.9 / 0.1 / 0.5 of its extent.',
    envelope: env(op('add', group(op('add', sym('a'), sym('b'))), sym('c'))),
    caret: nd([0]),
  },
  {
    id: 'K-03',
    category: 'K',
    label: '1234 + b — number glyph click',
    stress: 'Click the number glyph (mn) at fraction 0.3 of its extent.',
    envelope: env(op('add', num(1234), sym('b'))),
    caret: nd([0]),
  },
  {
    id: 'K-04',
    category: 'K',
    label: 'a + b + c — separator glyph click',
    stress: 'Click the second `+` separator mo.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 1),
  },
  {
    id: 'K-05',
    category: 'K',
    label: '□/b — placeholder click',
    stress: 'Click the □ placeholder mi.',
    envelope: env(frac(null, sym('b'))),
    caret: sl([], 'num'),
  },
  {
    id: 'K-06',
    category: 'K',
    label: '50 mm + x — unit symbol click',
    stress: 'Click the upright mm symbol mi at middle fractions of its extent.',
    envelope: env(op('add', unit(num(50), 'mm'), sym('x'))),
    caret: nd([0, 'value']),
  },

  // ——— U: undo/redo walk-backs ———
  {
    id: 'U-01',
    category: 'U',
    label: 'type `a+b*c`, then undo/redo',
    stress: 'Multi-step typed sequence, then Ctrl+Z ×3 and Ctrl+Y ×3.',
    keys: 'a+b*c',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'U-02',
    category: 'U',
    label: 'a + b, seam on the + — type then undo',
    stress: 'Type `*` at the seam, then Ctrl+Z.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: rw([], 1),
  },
  {
    id: 'U-03',
    category: 'U',
    label: 'type `a+b`, undo ×2, type `x`, redo',
    stress: 'Ctrl+Z ×2, type `x`, then Ctrl+Y.',
    keys: 'a+b',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },

  // ——— R: real-world formulas ———
  {
    id: 'R-01',
    category: 'R',
    label: '(−b+√(b²−4ac))/(2a) — quadratic formula, caret on the discriminant’s − seam',
    stress: 'Prebuilt quadratic formula — type `+` at the radicand seam, Backspace, arrows, Ctrl+Z.',
    envelope: env(
      frac(
        group(op('add', op('unaryMinus', sym('b')), root(op('add', pow(sym('b'), num(2)), op('unaryMinus', op('multiply', num(4), op('multiply', sym('a'), sym('c')))))))),
        op('multiply', num(2), sym('a')),
      ),
    ),
    caret: rw(['num', 'child', 1, 'radicand'], 1),
  },
  {
    id: 'R-02',
    category: 'R',
    label: 'type `b^2-4*a*c` (discriminant) from empty',
    stress: 'Typed-from-empty instruction `b^2-4*a*c`.',
    keys: 'b^2-4*a*c',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'R-03',
    category: 'R',
    label: '√(a²+b²) — Pythagorean root, caret on the + seam',
    stress: 'Type `×` at the radicand seam, Backspace on an exponent, Down/Up.',
    envelope: env(root(op('add', pow(sym('a'), num(2)), pow(sym('b'), num(2))))),
    caret: rw(['radicand'], 1),
  },
  {
    id: 'R-04',
    category: 'R',
    label: 'type `a^2+b^2` from empty',
    stress: 'Typed-from-empty instruction `a^2+b^2`.',
    keys: 'a^2+b^2',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },
  {
    id: 'R-05',
    category: 'R',
    label: 'π·r² — area of a circle, caret on the × seam',
    stress: 'Type `/` at the seam, Right.',
    envelope: env(op('multiply', sym('π'), pow(sym('r'), num(2)))),
    caret: rw([], 1),
  },
  {
    id: 'R-06',
    category: 'R',
    label: 'V/R — Ohm’s law, caret in the denominator',
    stress: 'Type `2` in the den; arrows to V; Ctrl+Backspace; Backspace at the num slot.',
    envelope: env(frac(sym('V'), sym('R'))),
    caret: nd(['den']),
  },
  {
    id: 'R-07',
    category: 'R',
    label: 'type `V/R` from empty',
    stress: 'Typed-from-empty instruction `V/R`.',
    keys: 'V/R',
    envelope: EMPTY_ENV,
    caret: EMPTY,
  },

  // ——— P: known-suspect probes ———
  {
    id: 'P-01',
    category: 'P',
    label: 'x + a/b, end seam after the fraction',
    stress: 'Probe: end seam after a non-row operand — Right, type `^`; reset; type `+`.',
    envelope: env(op('add', sym('x'), frac(sym('a'), sym('b')))),
    caret: rw([], 2),
  },
  {
    id: 'P-02',
    category: 'P',
    label: 'a + b at root, caret on b',
    stress: 'Probe: Right out of the root row’s last cell.',
    envelope: env(op('add', sym('a'), sym('b'))),
    caret: nd([1]),
  },
  {
    id: 'P-03',
    category: 'P',
    label: '(a+b)², caret after b in the base row',
    stress: 'Probe: Right out of the base row’s last cell (the row is nested in a power).',
    envelope: env(pow(op('add', sym('a'), sym('b')), num(2))),
    caret: nd(['base', 1]),
  },
  {
    id: 'P-04',
    category: 'P',
    label: '(a+b) + c — group edge-zone clicks',
    stress: 'Probe: click the group mrow at fractions 0.74 / 0.76 / 0.9 of its extent (edge-zone boundary).',
    envelope: env(op('add', group(op('add', sym('a'), sym('b'))), sym('c'))),
    caret: nd([0]),
  },
  {
    id: 'P-05',
    category: 'P',
    label: '1234 + 56/78 — row-cell number vs slot number clicks',
    stress: 'Probe: click the row-cell 1234 vs the numerator 56.',
    envelope: env(op('add', num(1234), frac(num(56), num(78)))),
    caret: nd([0]),
  },
  {
    id: 'P-06',
    category: 'P',
    label: '□/□, caret on the fraction itself',
    stress: 'Probe: self-on-container caret on a fraction with both slots empty — Down, Up, Left, Right.',
    envelope: env(frac(null, null)),
    caret: nd([]),
  },
  {
    id: 'P-07',
    category: 'P',
    label: 'a + b + c, caret on the first + seam',
    stress: 'Probe: watch the overlay caret div’s pixel position at the seam.',
    envelope: env(op('add', sym('a'), sym('b'), sym('c'))),
    caret: rw([], 1),
  },
  {
    id: 'P-08',
    category: 'P',
    label: '(a+b)/(c+d) — stacked-layout click',
    stress: 'Probe: click the outer mfrac’s left half at denominator height.',
    envelope: env(frac(op('add', sym('a'), sym('b')), op('add', sym('c'), sym('d')))),
    caret: nd(['num', 0]),
  },
];
