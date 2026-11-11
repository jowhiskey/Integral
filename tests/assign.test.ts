// The `=` key feature (2026-11-11, owner ruling A1–A7) — engine + AST acceptance
// pins. A1: eager insertion at the root row splitting EVERYTHING left/right of
// the caret (one place op = one undo unit). A2: the lhs is freely editable
// content. A3: empty slots render □ in both renderers. A4: the `=` glyph is a
// binding glyph — BS/Del at it splices lhs+rhs back into one plain row. A5:
// root-only firing (silent no-op everywhere else / inside an existing assign)
// + assignment-ness as a live eval state (isEvaluable). A6: the additive
// `assign` node, shape-only fromJSON, AssignmentNode projection.

import { describe, expect, it } from 'vitest';
import { parse } from 'mathjs';
import { fromJSON, isEvaluable, toJSON, toMathML, type Envelope, type NodeJson } from '../src/ast/index.js';
import {
  applyOp,
  backspace,
  caretResolvesIn,
  decideBackspace,
  decideDelete,
  envelopeOf,
  forwardDelete,
  initSession,
  redo,
  resolveMove,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type TypedToken,
} from '../src/engine/index.js';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const add = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'add', args });
const imp = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'multiply', args, implicit: true });
const group = (child: NodeJson | null): NodeJson => ({ type: 'group', parens: 'always', child });
const frac = (n: NodeJson | null, d: NodeJson | null): NodeJson => ({ type: 'frac', num: n, den: d });
const unit = (value: NodeJson | null, u: string): NodeJson => ({ type: 'unit', value, unit: u });
const asg = (lhs: NodeJson | null, rhs: NodeJson | null): NodeJson => ({ type: 'assign', lhs, rhs });

const EQ: TypedToken = { t: 'assign' };
const s = (ch: string): TypedToken => ({ t: 'leaf', node: { type: 'sym', name: ch } });
const d = (str: string): TypedToken => ({ t: 'leaf', node: { type: 'num', value: Number(str) } });

const j = (x: unknown): string => JSON.stringify(x);
const treeOf = (state: EditingState): NodeJson | null => envelopeOf(state).root;
const expectTree = (state: EditingState, expected: NodeJson | null): void => {
  expect(j(treeOf(state))).toBe(j(expected));
};
const expectLegal = (state: EditingState): void => {
  expect(() => fromJSON(envelopeOf(state))).not.toThrow();
  expect(caretResolvesIn(envelopeOf(state), state.caret)).toBe(true);
};
const at = (root: NodeJson | null, caret: Caret): EditingState => ({ ...initSession({ v: 1, root }), caret });
const rootIsEvaluable = (root: NodeJson | null): boolean => isEvaluable(fromJSON({ v: 1, root }));

// ——— A1: eager insertion at every ruled root-row position ———

describe('A1 — `=` inserts eagerly at the root row, one op = one undo unit', () => {
  it('from the completely empty formula: □=□, caret in the LHS (S-025 A template)', () => {
    const next = typeToken(initSession(), EQ);
    expectTree(next, asg(null, null));
    expect(next.caret).toEqual({ kind: 'slot', path: [], slot: 'lhs' });
    expect(next.log.length).toBe(1);
    expectLegal(next);
  });

  it('mid-row: at `a+b|c` the WHOLE `a+b` is the LHS (OA-both-halves), caret at the RHS start', () => {
    const next = typeToken(at(add(sym('a'), sym('b'), sym('c')), { kind: 'row', path: [], index: 2 }), EQ);
    expectTree(next, asg(add(sym('a'), sym('b')), sym('c')));
    expect(next.caret).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    expect(next.log.length).toBe(1);
    expectLegal(next);
  });

  it('mid-row with a row RHS: at `a|b+c` the RHS is the whole `b+c` row, caret at its start', () => {
    const next = typeToken(at(add(sym('a'), sym('b'), sym('c')), { kind: 'row', path: [], index: 1 }), EQ);
    expectTree(next, asg(sym('a'), add(sym('b'), sym('c'))));
    expect(next.caret).toEqual({ kind: 'token', path: ['rhs', 0], index: 0 });
    expectLegal(next);
  });

  it('symbol token interior: `ab|c` splits the token (lhs `ab`… `a|bc` halves)', () => {
    const next = typeToken(at(sym('abc'), { kind: 'token', path: [], index: 1 }), EQ);
    expectTree(next, asg(sym('a'), sym('bc')));
    expect(next.caret).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    expectLegal(next);
  });

  it('number token interior: `12|3` halves the number (123 → 12 = 3)', () => {
    const next = typeToken(at(num(123), { kind: 'token', path: [], index: 2 }), EQ);
    expectTree(next, asg(num(12), num(3)));
    expect(next.caret).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    expectLegal(next);
  });

  it('token end: `ab|` grabs the whole token as LHS, □ RHS, caret at the RHS start', () => {
    const next = typeToken(at(sym('ab'), { kind: 'token', path: [], index: 2 }), EQ);
    expectTree(next, asg(sym('ab'), null));
    expect(next.caret).toEqual({ kind: 'slot', path: [], slot: 'rhs' });
    expectLegal(next);
  });

  it('offset 0 with content: □ LHS + the content in the RHS, caret at the RHS start (flagged live-check item)', () => {
    const row = typeToken(at(add(sym('a'), sym('b')), { kind: 'row', path: [], index: 0 }), EQ);
    expectTree(row, asg(null, add(sym('a'), sym('b'))));
    expect(row.caret).toEqual({ kind: 'token', path: ['rhs', 0], index: 0 });
    const tok = typeToken(at(sym('ab'), { kind: 'token', path: [], index: 0 }), EQ);
    expectTree(tok, asg(null, sym('ab')));
    expect(tok.caret).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    expectLegal(row);
    expectLegal(tok);
  });

  it('a token cell of the root row splits with its row: `x + a|b` → lhs `x+a`, rhs `b`', () => {
    const next = typeToken(at(add(sym('x'), sym('ab')), { kind: 'token', path: [1], index: 1 }), EQ);
    expectTree(next, asg(add(sym('x'), sym('a')), sym('b')));
    expect(next.caret).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    expectLegal(next);
  });

  it('a lone structure at the root grabs whole: after-station `(a+b)|` → LHS the group, □ RHS; left flank → □ LHS + group RHS', () => {
    const g = group(add(sym('a'), sym('b')));
    const after = typeToken(at(g, { kind: 'node', path: [] }), EQ);
    expectTree(after, asg(g, null));
    expect(after.caret).toEqual({ kind: 'slot', path: [], slot: 'rhs' });
    const before = typeToken(at(g, { kind: 'node', path: [], side: 'left' }), EQ);
    expectTree(before, asg(null, g));
    expect(before.caret).toEqual({ kind: 'node', path: ['rhs'], side: 'left' });
    expectLegal(after);
    expectLegal(before);
  });

  it('a pending null cell of the root row splits at the caret index (judgment call: the null goes right)', () => {
    const next = typeToken(at(add(sym('a'), null), { kind: 'row', path: [], index: 1 }), EQ);
    expectTree(next, asg(sym('a'), null));
    expect(next.caret).toEqual({ kind: 'slot', path: [], slot: 'rhs' });
    expectLegal(next);
  });

  it('a pair-gap station splits at the caret — the gap dissolves into the slots (judgment call on the named ambiguity)', () => {
    // legal pair seam `5|x` (redirects to the seam): lhs 5, rhs x
    const legal = typeToken(at(imp(num(5), sym('x')), { kind: 'row', path: [], index: 1 }), EQ);
    expectTree(legal, asg(num(5), sym('x')));
    // illegal pair edge station `x|5` (sym-before-num keeps its edge stations): split at the token edge
    const illegal = typeToken(at(imp(sym('x'), num(5)), { kind: 'token', path: [1], index: 0 }), EQ);
    expectTree(illegal, asg(sym('x'), num(5)));
    expectLegal(legal);
    expectLegal(illegal);
  });

  it('insertion + split + grab is ONE undo unit — undo byte-restores the unsplit row AND caret, redo replays', () => {
    const seed = at(add(sym('a'), sym('b'), sym('c')), { kind: 'row', path: [], index: 2 });
    const next = typeToken(seed, EQ);
    expect(next.log.length).toBe(1);
    const back = undo(next);
    expect(j(treeOf(back))).toBe(j(add(sym('a'), sym('b'), sym('c'))));
    expect(j(back.caret)).toBe(j({ kind: 'row', path: [], index: 2 }));
    const again = redo(next === back ? back : back); // redo walks the redo list of `next`
    const re = redo(undo(next));
    expect(j(treeOf(re))).toBe(j(asg(add(sym('a'), sym('b')), sym('c'))));
    expect(j(re.caret)).toBe(j({ kind: 'token', path: ['rhs'], index: 0 }));
    void again;
  });
});

// ——— A5: root-only firing — silent no-op everywhere else ———

describe('A5 — `=` fires only at the root row; inside an existing assign it is a silent no-op', () => {
  it('no-op inside the assign slots (lhs □, rhs, in-token positions, node-on-assign)', () => {
    const cases: [NodeJson, Caret][] = [
      [asg(null, null), { kind: 'slot', path: [], slot: 'lhs' }],
      [asg(null, null), { kind: 'slot', path: [], slot: 'rhs' }],
      [asg(sym('x'), sym('ab')), { kind: 'token', path: ['rhs'], index: 1 }],
      [asg(sym('ab'), num(5)), { kind: 'token', path: ['lhs'], index: 1 }],
      [asg(sym('x'), num(5)), { kind: 'node', path: [] }],
      [asg(add(sym('a'), sym('b')), num(5)), { kind: 'row', path: ['lhs'], index: 1 }],
    ];
    for (const [root, caret] of cases) {
      const state = at(root, caret);
      const next = typeToken(state, EQ);
      expect(next).toBe(state); // byte-identical silent no-op: nothing logged
      expect(next.log.length).toBe(0);
    }
  });

  it('no-op at non-root-row positions (a slot of a root frac, a nested row, a nested token)', () => {
    const cases: [NodeJson, Caret][] = [
      [frac(null, num(2)), { kind: 'slot', path: [], slot: 'num' }],
      [frac(add(sym('a'), sym('b')), num(2)), { kind: 'row', path: ['num'], index: 2 }],
      [frac(num(12), num(2)), { kind: 'token', path: ['num'], index: 1 }],
      [add(sym('x'), frac(sym('a'), sym('b'))), { kind: 'token', path: [1, 'num'], index: 0 }],
    ];
    for (const [root, caret] of cases) {
      const state = at(root, caret);
      expect(typeToken(state, EQ)).toBe(state);
    }
  });

  it('nesting/chaining impossible by construction: a seeded nested assign also no-ops on `=`', () => {
    const root = asg(sym('x'), frac(asg(sym('y'), num(1)), num(2)));
    const caret: Caret = { kind: 'token', path: ['rhs', 'num', 'lhs'], index: 1 };
    const state = at(root, caret);
    expect(typeToken(state, EQ)).toBe(state);
    expectLegal(state);
  });
});

// ——— A2/A6: the LHS is freely editable; assignment-ness re-derives live ———

describe('A2 — the LHS is freely editable content (never atomic, never frozen)', () => {
  it('in-token T3 glue at any offset incl. digit-glue: `x1` is a legal symbol name', () => {
    const glued = typeToken(at(asg(sym('x'), num(5)), { kind: 'token', path: ['lhs'], index: 1 }), s('1'));
    expectTree(glued, asg(sym('x1'), num(5)));
    const mid = typeToken(at(asg(sym('ab'), num(5)), { kind: 'token', path: ['lhs'], index: 1 }), s('c'));
    expectTree(mid, asg(sym('acb'), num(5)));
    expectLegal(glued);
    expectLegal(mid);
  });

  it('letter-wise D1 deletion inside the LHS', () => {
    const state = at(asg(sym('ab'), num(5)), { kind: 'token', path: ['lhs'], index: 2 });
    const next = backspace(state);
    expectTree(next, asg(sym('a'), num(5)));
    expect(next.caret).toEqual({ kind: 'token', path: ['lhs'], index: 1 });
  });

  it('multi-node LHS is a normal storable state while it lasts', () => {
    const state = at(asg(add(sym('a'), sym('b')), num(5)), { kind: 'row', path: ['lhs'], index: 1 });
    expectLegal(state);
    expect(rootIsEvaluable(asg(add(sym('a'), sym('b')), num(5)))).toBe(false); // declined, still stored
    expect(typeToken(state, s('c'))).not.toBe(state); // editable
  });
});

describe('A5/A6 — assignment-ness re-derives continuously with the LHS content (both directions)', () => {
  it('live → declined on a breaking edit (symbol emptied)', () => {
    expect(rootIsEvaluable(asg(sym('x'), num(3)))).toBe(true);
    const state = at(asg(sym('x'), num(3)), { kind: 'token', path: ['lhs'], index: 1 });
    const next = backspace(state);
    expectTree(next, asg(null, num(3)));
    expect(rootIsEvaluable(treeOf(next))).toBe(false);
  });

  it('declined → live on a rename into a bare symbol', () => {
    expect(rootIsEvaluable(asg(num(5), num(3)))).toBe(false); // number LHS: declined
    const emptied = backspace(at(asg(num(5), num(3)), { kind: 'token', path: ['lhs'], index: 1 }));
    expectTree(emptied, asg(null, num(3)));
    expect(emptied.caret).toEqual({ kind: 'slot', path: [], slot: 'lhs' });
    const renamed = typeToken(emptied, s('x'));
    expectTree(renamed, asg(sym('x'), num(3)));
    expect(rootIsEvaluable(treeOf(renamed))).toBe(true);
  });

  it('every other LHS shape is DECLINED evaluation but storable + renders (no dissolve)', () => {
    const shapes: [string, NodeJson][] = [
      ['empty', null],
      ['number', num(5)],
      ['multi-node row', add(sym('a'), sym('b'))],
      ['group', group(sym('a'))],
      ['structure', frac(num(1), num(2))],
      ['unit', unit(num(5), 'm')],
      ['empty-name symbol', sym('')],
    ];
    for (const [label, lhs] of shapes) {
      const root = asg(lhs, num(3));
      expect(() => fromJSON({ v: 1, root })).not.toThrow();
      expect(rootIsEvaluable(root)).toBe(false);
      expect(toMathML(fromJSON({ v: 1, root }))).toContain('=');
      expect(label).toBeTruthy();
    }
    // RHS must be evaluable too
    expect(rootIsEvaluable(asg(sym('x'), null))).toBe(false);
    expect(rootIsEvaluable(asg(sym('x'), add(num(5), num(3))))).toBe(true);
  });
});

// ——— A3: empty slots render □ in BOTH renderers, byte-parallel ———

describe('A3 — empty slots render □ (string renderer pins; DOM parity in the editor suite)', () => {
  it('□=□ from empty, □=rhs at offset 0, x=□ after conversion — the T7 split reading', () => {
    expect(toMathML(fromJSON({ v: 1, root: asg(null, null) }))).toBe(
      '<math><mrow><mi>□</mi><mo>=</mo><mi>□</mi></mrow></math>',
    );
    expect(toMathML(fromJSON({ v: 1, root: asg(null, num(5)) }))).toBe(
      '<math><mrow><mi>□</mi><mo>=</mo><mn>5</mn></mrow></math>',
    );
    expect(toMathML(fromJSON({ v: 1, root: asg(sym('x'), null) }))).toBe(
      '<math><mrow><mi>x</mi><mo>=</mo><mi>□</mi></mrow></math>',
    );
  });

  it('the □ persists while the slot is empty regardless of caret position (rendering is caret-independent)', () => {
    const root = fromJSON({ v: 1, root: asg(null, num(5)) });
    expect(toMathML(root)).toBe('<math><mrow><mi>□</mi><mo>=</mo><mn>5</mn></mrow></math>');
    const withCaret = at(asg(null, num(5)), { kind: 'token', path: ['rhs'], index: 0 });
    expect(toMathML(fromJSON(envelopeOf(withCaret)))).toBe(toMathML(root));
  });
});

// ——— A4: the `=` glyph is a binding glyph — BS/Del splice lhs+rhs into one plain row ———

describe('A4 — BS/Del at the `=` glyph removes it and splices the sides into one plain row', () => {
  it('BS at the RHS start (token offset 0): the `=` junction becomes a GAP, never an operator (rec-mwcq61uh-0) — `a+b=c` → `a+(b c)` implicit pair, caret at the gap’s right edge', () => {
    const state = at(asg(add(sym('a'), sym('b')), sym('c')), { kind: 'token', path: ['rhs'], index: 0 });
    const dec = decideBackspace(envelopeOf(state), state.caret);
    expect(dec.kind).toBe('glyph');
    const next = backspace(state);
    expectTree(next, add(sym('a'), imp(sym('b'), sym('c'))));
    expect(next.caret).toEqual({ kind: 'token', path: [1, 1], index: 0 });
    expect(next.log.length).toBe(1); // one undo unit
    expectLegal(next);
    // only a further BS at the gap merges the two symbols to one (the merge table)
    const merged = backspace(next);
    expectTree(merged, add(sym('a'), sym('bc')));
    expect(merged.caret).toEqual({ kind: 'token', path: [1], index: 1 });
  });

  it('the junction is a gap for every op-row side shape: explicit rhs row, both rows, implicit-row absorb', () => {
    // explicit rhs row: the lhs pairs with the rhs's FIRST cell
    const rhsRow = backspace(at(asg(sym('x'), add(sym('c'), sym('d'))), { kind: 'row', path: ['rhs'], index: 0 }));
    expectTree(rhsRow, add(imp(sym('x'), sym('c')), sym('d')));
    expect(rhsRow.caret).toEqual({ kind: 'token', path: [0, 1], index: 0 });
    // both explicit op rows: the lhs's edge cell pairs with the rhs as a whole
    const both = backspace(at(asg(add(sym('a'), sym('b')), add(sym('c'), sym('d'))), { kind: 'row', path: ['rhs'], index: 0 }));
    expectTree(both, add(sym('a'), imp(sym('b'), add(sym('c'), sym('d')))));
    expect(both.caret).toEqual({ kind: 'row', path: [1], index: 1 });
    // an implicit row absorbs (its junction is already an implicit seam)
    const implicit = backspace(at(asg(imp(sym('x'), sym('y')), sym('c')), { kind: 'token', path: ['rhs'], index: 0 }));
    expectTree(implicit, imp(sym('x'), sym('y'), sym('c')));
    expect(implicit.caret).toEqual({ kind: 'row', path: [], index: 2 });
  });

  it('BS at the RHS □ (empty rhs): the lhs promotes at the assign position', () => {
    const next = backspace(at(asg(sym('x'), null), { kind: 'slot', path: [], slot: 'rhs' }));
    expectTree(next, sym('x'));
    expect(next.caret).toEqual({ kind: 'token', path: [], index: 1 });
  });

  it('BS at the LHS □ takes the same splice (judgment call): rhs promotes; both empty → outright death', () => {
    const promoted = backspace(at(asg(null, num(5)), { kind: 'slot', path: [], slot: 'lhs' }));
    expectTree(promoted, num(5));
    const dead = backspace(at(asg(null, null), { kind: 'slot', path: [], slot: 'lhs' }));
    expectTree(dead, null);
    expect(dead.caret).toEqual({ kind: 'empty' });
  });

  it('merge-table fusion: split number re-merges (`12|3` → 12=3 → BS → 123); sym+num digit-glues (`x=5` → x5)', () => {
    const numState = at(asg(num(12), num(3)), { kind: 'token', path: ['rhs'], index: 0 });
    const numNext = backspace(numState);
    expectTree(numNext, num(123));
    expect(numNext.caret).toEqual({ kind: 'token', path: [], index: 2 });
    const symState = at(asg(sym('x'), num(5)), { kind: 'token', path: ['rhs'], index: 0 });
    const symNext = backspace(symState);
    expectTree(symNext, sym('x5'));
    expect(symNext.caret).toEqual({ kind: 'token', path: [], index: 1 });
  });

  it('non-fusing sides bond into an implicit pair at the assign position (`x=(a+b)` → BS → `x(a+b)` pair)', () => {
    const g = group(sym('a'));
    const next = backspace(at(asg(sym('x'), g), { kind: 'node', path: ['rhs'], side: 'left' }));
    expectTree(next, imp(sym('x'), g));
    expect(next.caret).toEqual({ kind: 'row', path: [], index: 1 });
    expectLegal(next);
  });

  it('forward Del at the LHS end is the mirror (token end, container right flank, row end)', () => {
    const tok = forwardDelete(at(asg(sym('x'), num(5)), { kind: 'token', path: ['lhs'], index: 1 }));
    expectTree(tok, sym('x5'));
    const g = group(sym('a'));
    const flank = forwardDelete(at(asg(g, num(5)), { kind: 'node', path: ['lhs'], side: 'right' }));
    expectTree(flank, imp(g, num(5)));
    const rowEnd = forwardDelete(at(asg(add(sym('a'), sym('b')), num(5)), { kind: 'row', path: ['lhs'], index: 2 }));
    expectTree(rowEnd, add(sym('a'), imp(sym('b'), num(5)))); // the junction is a gap, not a `+`
    expect(rowEnd.caret).toEqual({ kind: 'token', path: [1, 1], index: 0 });
  });

  it('an assign mid-row: the glyph rule splices at the assign cell (sym+sym fuses per the merge table); undo restores the assign', () => {
    const state = at(add(sym('x'), asg(sym('a'), sym('b'))), { kind: 'token', path: [1, 'rhs'], index: 0 });
    const next = backspace(state);
    expectTree(next, add(sym('x'), sym('ab')));
    expect(next.caret).toEqual({ kind: 'token', path: [1], index: 1 });
    expect(next.log.length).toBe(1); // the glyph removal is one undo unit
    expectTree(undo(next), add(sym('x'), asg(sym('a'), sym('b'))));
  });

  it('Del at a □ keeps the named no-op; BS into the assign from a row seam descends into the rhs', () => {
    const delNoop = decideDelete(envelopeOf(at(asg(sym('x'), null), { kind: 'slot', path: [], slot: 'rhs' })), { kind: 'slot', path: [], slot: 'rhs' });
    expect(delNoop.kind).toBe('noop');
    const descend = backspace(at(add(sym('x'), asg(sym('a'), sym('b'))), { kind: 'row', path: [], index: 2 }));
    expectTree(descend, add(sym('x'), asg(sym('a'), null)));
  });
});

// ——— A6: the AST + eval contract ———

describe('A6 — assign node contract: shape-only fromJSON, root-only gate, AssignmentNode projection', () => {
  it('toJSON/fromJSON round-trip; missing slots read as null; envelope stays v1', () => {
    const env: Envelope = { v: 1, root: asg(sym('x'), add(num(5), num(3))) };
    expect(toJSON(fromJSON(env))).toEqual(env);
    const missing = fromJSON({ v: 1, root: { type: 'assign' } });
    expect(toJSON(missing)).toEqual({ v: 1, root: asg(null, null) });
  });

  it('fromJSON validates SHAPE only: a declined-LHS envelope round-trips (no identifier check); bad shapes reject', () => {
    const declined: Envelope = { v: 1, root: asg(num(5), num(3)) };
    expect(toJSON(fromJSON(declined))).toEqual(declined);
    expect(() => fromJSON({ v: 1, root: { type: 'assign', lhs: [num(1)], rhs: null } })).toThrow(/single node/);
    expect(() => fromJSON({ v: 1, root: { type: 'assign', lhs: 42, rhs: null } })).toThrow(/node object/);
  });

  it('isEvaluable is root-only: an assign nested in a slot (seedable via fromJSON) refuses the gate', () => {
    const nested = fromJSON({ v: 1, root: frac(asg(sym('x'), num(1)), num(2)) });
    expect(isEvaluable(nested)).toBe(false);
    expect(isEvaluable(fromJSON({ v: 1, root: asg(sym('x'), num(1)) }))).toBe(true);
  });

  it('toMathNode projects mathjs AssignmentNode — standalone parity (declined shapes throw)', () => {
    const live = fromJSON({ v: 1, root: asg(sym('x'), add(num(5), num(3))) })!;
    const mn = live.toMathNode();
    expect(mn.type).toBe('AssignmentNode');
    expect(mn.toString()).toBe(parse('x = 5 + 3').toString());
    const scope: Record<string, unknown> = {};
    // @ts-expect-error mathjs Node.evaluate takes a scope
    expect(mn.evaluate(scope)).toBe(8);
    expect(scope.x).toBe(8);
    expect(() => fromJSON({ v: 1, root: asg(num(5), num(3)) })!.toMathNode()).toThrow(/declined/);
    expect(() => fromJSON({ v: 1, root: asg(null, num(3)) })!.toMathNode()).toThrow(/empty/);
  });

  it('budgets and fence pairing see through the assign slots', () => {
    // depth budget: assign nests like any slot
    let deep: NodeJson = num(1);
    for (let i = 0; i < 101; i++) deep = asg(deep, num(0));
    expect(() => fromJSON({ v: 1, root: deep })).toThrow(/depth budget/);
    // a fence token inside an assign's slot pairs against an open fence through lhs/rhs
    const env: Envelope = {
      v: 1,
      root: asg({ type: 'group', parens: 'always', child: null, close: false }, { type: 'fence', side: 'close', open: ['lhs'] }),
    };
    expect(() => fromJSON(env)).not.toThrow();
    expect(() => fromJSON({ v: 1, root: asg(null, { type: 'fence', side: 'close', open: ['lhs'] }) })).toThrow(/missing its own closing fence/);
  });
});

// ——— A5/A6 navigation: both slots walk-reachable per the two-slot pattern ———

describe('nav — the assign profile (flow lhs→rhs, horizontal edges across the glyph, no vertical edges)', () => {
  it('horizontal walk: lhs end → rhs start → rhs end exits; rhs start ← → lhs end', () => {
    const env: Envelope = { v: 1, root: asg(sym('x'), num(5)) };
    expect(resolveMove(env, { kind: 'token', path: ['lhs'], index: 1 }, 'right')).toEqual({
      kind: 'token', path: ['rhs'], index: 0,
    });
    expect(resolveMove(env, { kind: 'token', path: ['rhs'], index: 0 }, 'left')).toEqual({
      kind: 'token', path: ['lhs'], index: 1,
    });
    // from the empty lhs slot, → dives into the rhs
    expect(resolveMove(env, { kind: 'slot', path: [], slot: 'lhs' }, 'right')).toEqual({
      kind: 'token', path: ['rhs'], index: 0,
    });
    // no vertical edges: up/down climb and no-op at the root
    expect(resolveMove(env, { kind: 'slot', path: [], slot: 'lhs' }, 'down')).toBe(null);
    // rhs end → exits the formula end (N3 no-op at the bare assign root)
    expect(resolveMove(env, { kind: 'token', path: ['rhs'], index: 1 }, 'right')).toBe(null);
    expect(resolveMove(env, { kind: 'token', path: ['lhs'], index: 0 }, 'left')).toBe(null);
  });

  it('a mid-row assign walks through from the row: → dives into lhs, rhs end → exits to the next cell', () => {
    const env: Envelope = { v: 1, root: add(sym('x'), asg(sym('a'), sym('b')), sym('y')) };
    expect(resolveMove(env, { kind: 'token', path: [0], index: 1 }, 'right')).toEqual({
      kind: 'token', path: [1, 'lhs'], index: 0,
    });
    expect(resolveMove(env, { kind: 'token', path: [1, 'rhs'], index: 1 }, 'right')).toEqual({
      kind: 'token', path: [2], index: 0,
    });
    expect(resolveMove(env, { kind: 'token', path: [2], index: 0 }, 'left')).toEqual({
      kind: 'token', path: [1, 'rhs'], index: 1,
    });
  });

  it('the slots are click/typing-reachable: caret resolution + firstEmpty natural continue', () => {
    const s1 = initSession({ v: 1, root: asg(null, num(5)) });
    expect(s1.caret).toEqual({ kind: 'slot', path: [], slot: 'lhs' }); // natural continue into the empty lhs
    const s2 = initSession({ v: 1, root: asg(sym('x'), num(5)) });
    expect(caretResolvesIn(envelopeOf(s2), s2.caret)).toBe(true);
    // typing at the seeded lhs slot fills it (A2 surface)
    const typed = typeToken(at(asg(null, num(5)), { kind: 'slot', path: [], slot: 'lhs' }), s('x'));
    expectTree(typed, asg(sym('x'), num(5)));
    expect(rootIsEvaluable(treeOf(typed))).toBe(true);
  });
});
