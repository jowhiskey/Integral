// @vitest-environment jsdom
// Contract state layer (interaction.md, rework session 1): the □/bare render
// split (T7/S-023/S-025/S-027/S-079), the fence-state fields (C4/S-097 + Owner
// amendment), the implicit juxtaposition marker (Owner amendment + S-098), and
// the empty-slot operator-row projection (Owner amendment). Pinned against the
// binding contract; behavior (typing/nav/clicks) is later sessions' territory.

import { describe, expect, it } from 'vitest';
import { parse } from 'mathjs';

import {
  FenceNode,
  FunctionNode,
  GroupNode,
  NumberNode,
  OperatorNode,
  SymbolNode,
  fromJSON,
  isEvaluable,
  toMathML,
  toJSON,
  type Envelope,
  type NodeJson,
} from '../src/ast/index.js';

import { caretAnchor } from '../src/editor/caret-overlay.js';
import { caretResolvesIn } from '../src/engine/index.js';
import { buildMathML } from '../src/editor/mathml-dom.js';
import type { Caret } from '../src/engine/index.js';
import { stubRects } from './editor-support.js';

// S-098 seam carrier (rework 2b-1): the mspace carries explicit MathML Core
// height/depth — its default height is 0 and a background-only host tint
// would paint an invisible zero-height strip (the demo CSS hack is deleted;
// hosts paint a plain tint on the carrier's own box).
const SEAM = '<mspace class="integral-seam" width="0.1667em" height="0.75em" depth="0.2em"/>';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const rowOf = (opName: string, ...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: opName, args });
const imp = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'multiply', args, implicit: true });
const fnJson = (name: string, args: (NodeJson | null)[], close = true): NodeJson =>
  close ? { type: 'fn', name, args } : { type: 'fn', name, args, close: false };
const group = (child: NodeJson | null, close = true): NodeJson =>
  close ? { type: 'group', parens: 'always', child } : { type: 'group', parens: 'always', child, close: false };
const fence = (open?: (number | string)[]): NodeJson =>
  open === undefined ? { type: 'fence', side: 'close' } : { type: 'fence', side: 'close', open };
const env = (root: NodeJson | null): Envelope => ({ v: 1, root });
const mathOf = (root: NodeJson | null): string => toMathML(fromJSON(env(root)));

// ——— 1. The □/bare render split (T7: 2D-slot placeholders vs BARE rows) ———

describe('□: empty 2D-structure slots render exactly one visible placeholder', () => {
  it.each([
    ['frac numerator', { type: 'frac', num: null, den: num(2) }],
    ['frac denominator', { type: 'frac', num: num(2), den: null }],
    ['pow exponent', { type: 'pow', base: sym('x'), exp: null }],
    ['root radicand', { type: 'root', radicand: null }],
    ['root index (mroot with an empty index slot)', { type: 'root', radicand: num(2), index: null, mroot: true }],
    ['fn argument', fnJson('f', [null])],
    ['emptied group content', group(null)],
  ])('%s → exactly one □', (_label, root) => {
    const math = mathOf(root);
    expect(math).toContain('<mi>□</mi>');
    expect(math.split('□').length - 1).toBe(1);
  });

  it('both empty fraction slots → one □ per slot (two total)', () => {
    const math = mathOf({ type: 'frac', num: null, den: null });
    expect(math.split('□').length - 1).toBe(2);
  });

  it('□ persists independent of caret position (S-027) — rendering takes no caret', () => {
    // The MathML projection is a pure tree walk; the □ is the standing
    // affordance and never depends on where the caret sits.
    const a = mathOf({ type: 'frac', num: null, den: num(2) });
    expect(a).toContain('<mi>□</mi>');
    expect(mathOf({ type: 'frac', num: null, den: num(2) })).toBe(a);
  });

  it('v1 square-root semantics stay byte-unchanged; mroot is the additive empty-index encoding', () => {
    // index null WITHOUT the flag stays the complete square root (unchanged v1);
    // WITH the flag the index slot exists and renders its □ (judgment call: v1's
    // "index null = square root" cannot express an empty mroot index otherwise).
    expect(mathOf({ type: 'root', radicand: num(16) })).toBe('<math><msqrt><mn>16</mn></msqrt></math>');
    expect(mathOf({ type: 'root', radicand: num(16), index: null })).toBe('<math><msqrt><mn>16</mn></msqrt></math>');
    const mroot = fromJSON(env({ type: 'root', radicand: num(16), index: null, mroot: true }))!;
    expect(mroot.toMathML()).toBe('<math><mroot><mn>16</mn><mi>□</mi></mroot></math>');
    expect(isEvaluable(mroot)).toBe(false); // empty index slot: incomplete
    expect(() => mroot.toMathNode()).toThrow(/index slot is empty/);
    expect(toJSON(mroot)).toStrictEqual({ v: 1, root: { type: 'root', radicand: num(16), mroot: true } });
    expect(() =>
      fromJSON(env({ type: 'root', radicand: num(2), index: num(3), mroot: true })),
    ).toThrow(/mroot/); // the flag belongs to the EMPTY slot only
  });
});

describe('BARE: row-level missing operands render NO placeholder (leading/trailing/interior/all-null)', () => {
  it.each([
    ['leading − (negation shape)', rowOf('subtract', null, sym('x')), '<math><mrow><mo>−</mo><mi>x</mi></mrow></math>'],
    ['leading + (identity shape)', rowOf('add', null, sym('x')), '<math><mrow><mo>+</mo><mi>x</mi></mrow></math>'],
    ['trailing + (`5+`)', rowOf('add', num(5), null), '<math><mrow><mn>5</mn><mo>+</mo></mrow></math>'],
    [
      'trailing −x+ (nested glyphs)',
      rowOf('add', rowOf('subtract', null, sym('x')), null),
      '<math><mrow><mrow><mo>−</mo><mi>x</mi></mrow><mo>+</mo></mrow></math>',
    ],
    ['interior doubled `2−−3`', rowOf('subtract', num(2), null, num(3)), '<math><mrow><mn>2</mn><mo>−</mo><mo>−</mo><mn>3</mn></mrow></math>'],
    ['interior doubled `a+b++c`', rowOf('add', sym('a'), sym('b'), null, sym('c')), '<math><mrow><mi>a</mi><mo>+</mo><mi>b</mi><mo>+</mo><mo>+</mo><mi>c</mi></mrow></math>'],
    ['all-null row `+`', rowOf('add', null, null), '<math><mrow><mo>+</mo></mrow></math>'],
    ['operand-less row (empty args)', rowOf('add'), '<math><mrow></mrow></math>'],
    ['single null cell, no glyph', rowOf('subtract', null), '<math><mrow></mrow></math>'],
  ])('%s renders bare', (_label, root, expected) => {
    expect(mathOf(root)).toBe(expected);
  });

  it('a row with an interior null cell renders zero □ anywhere (T7 split)', () => {
    expect(mathOf(rowOf('add', sym('a'), null, sym('c')))).not.toContain('□');
  });

  it('unary op rows render bare too: unaryMinus(null) is the lone glyph', () => {
    expect(new OperatorNode('unaryMinus', [null]).toMathML()).toBe('<math><mrow><mo>−</mo></mrow></math>');
  });

  it('a unary node and its projected row equivalent render identically', () => {
    const asUnary = new OperatorNode('unaryMinus', [new SymbolNode('x')]);
    const asRow = new OperatorNode('subtract', [null, new SymbolNode('x')]);
    expect(asRow.toMathML()).toBe(asUnary.toMathML());
  });
});

// ——— 2. The bare-cell caret anchor (the overlay fallback) ———

describe('bare-cell caret anchor: a defined, visible anchor for every bare state', () => {
  const sepOf = (rendered: ReturnType<typeof buildMathML>, index: number): Element =>
    [...rendered.separators.entries()].find(([, s]) => s.index === index)![0];

  it('interior null cell → right edge of the preceding glyph (left glyph wins)', () => {
    const root = rowOf('add', sym('a'), null, sym('b'));
    const e = env(root);
    const rendered = buildMathML(fromJSON(e)!, document);
    const stub = stubRects();
    stub.set(sepOf(rendered, 1), { left: 10, top: 2, width: 5, height: 11 });
    const anchor = caretAnchor(e, { kind: 'row', path: [], index: 1 } satisfies Caret, rendered);
    expect(anchor).toEqual({ x: 15, y: 2, height: 11 });
  });

  it('leading null cell → left edge of the following glyph; trailing null → right edge of the preceding', () => {
    const root = rowOf('subtract', null, sym('x'), null); // `−x−`
    const e = env(root);
    const rendered = buildMathML(fromJSON(e)!, document);
    const stub = stubRects();
    stub.setMath({ left: 0, top: 0, width: 30, height: 14 });
    stub.set(sepOf(rendered, 1), { left: 0, top: 0, width: 5, height: 14 });
    stub.set(sepOf(rendered, 2), { left: 25, top: 0, width: 5, height: 14 });
    expect(caretAnchor(e, { kind: 'row', path: [], index: 0 } satisfies Caret, rendered)).toEqual({ x: 0, y: 0, height: 14 });
    expect(caretAnchor(e, { kind: 'row', path: [], index: 2 } satisfies Caret, rendered)).toEqual({ x: 30, y: 0, height: 14 });
  });

  it('glyph-less rows (single null cell) anchor at the row owner with the math height — never invisible', () => {
    const root = rowOf('add', null);
    const e = env(root);
    const rendered = buildMathML(fromJSON(e)!, document);
    const stub = stubRects();
    stub.setMath({ left: 0, top: 4, width: 10, height: 16 });
    stub.set(rendered.elementByPath.get('[]')!, { left: 2, top: 4, width: 0, height: 0 });
    const anchor = caretAnchor(e, { kind: 'row', path: [], index: 0 } satisfies Caret, rendered);
    expect(anchor).toEqual({ x: 2, y: 4, height: 16 }); // math height: visible, not 0
  });
});

// ——— 3. Fence-state fields (C4/S-097: storable + renders; refused by the gate) ———

describe('fence-state fields: round-trip identity, refusal, envelope v1', () => {
  const unbalanced = env(group(rowOf('add', sym('a'), sym('b')), false)); // `(a+b`
  const unclosedFn = env(fnJson('sin', [sym('x')], false)); // `sin(x`
  const dangling = env(rowOf('add', sym('x'), fence())); // `x+)`
  const displaced = env({
    // the movable-paren displaced close: pairs with the numerator's open fence
    type: 'frac',
    num: group(rowOf('add', sym('a'), sym('b')), false), // `(a+b`
    den: rowOf('add', num(2), fence(['num'])), // `2 + )`
  });

  it.each([
    ['group without close', unbalanced],
    ['fn without close', unclosedFn],
    ['dangling close in a row', dangling],
    ['displaced paired close (open path)', displaced],
  ])('%s: fromJSON→toJSON round-trip identity (envelope v1)', (_label, e) => {
    const ast = fromJSON(e)!;
    expect(toJSON(ast)).toStrictEqual(e);
    expect(toJSON(fromJSON(toJSON(ast))!)).toStrictEqual(e);
  });

  it.each([
    ['group without close', unbalanced],
    ['fn without close', unclosedFn],
    ['row containing a dangling close', dangling],
    ['row containing a displaced close', displaced],
    ['nested: refused through the existing gate', env(rowOf('add', group(num(1), false), num(2)))],
  ])('%s: evaluation refuses via the existing structural gate', (_label, e) => {
    expect(isEvaluable(fromJSON(e)!)).toBe(false);
  });

  it('balanced states stay byte-unchanged: no close/implicit fields are emitted', () => {
    expect(toJSON(fromJSON(env(group(sym('x'))))!)).toStrictEqual({ v: 1, root: { type: 'group', parens: 'always', child: sym('x') } });
    expect(toJSON(fromJSON(env(fnJson('sin', [sym('x')])))!)).toStrictEqual({ v: 1, root: fnJson('sin', [sym('x')]) });
    expect(toJSON(fromJSON(env(rowOf('multiply', sym('x'), num(3))))!)).toStrictEqual({ v: 1, root: rowOf('multiply', sym('x'), num(3)) });
  });

  it('renders: the open rows stand open, close tokens render their glyph', () => {
    expect(mathOf(displaced.root)).toBe(
      '<math><mfrac><mrow><mo fence="true">(</mo><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mrow><mn>2</mn><mo>+</mo><mo fence="true">)</mo></mrow></mfrac></math>',
    );
    expect(mathOf(group(rowOf('add', sym('a'), sym('b')), false))).toBe(
      '<math><mrow><mo fence="true">(</mo><mi>a</mi><mo>+</mo><mi>b</mi></mrow></math>',
    );
    expect(mathOf(fnJson('sin', [sym('x')], false))).toBe('<math><mrow><mi>sin</mi><mo fence="true">(</mo><mi>x</mi></mrow></math>');
    expect(mathOf(fence())).toBe('<math><mo fence="true">)</mo></math>');
  });

  it('validation: pairing paths must resolve to an unbalanced group/fn; side is close-only', () => {
    expect(() => fromJSON(env(rowOf('add', sym('x'), fence(['den']))))).toThrow(/fence\.open/); // resolves to nothing
    expect(() => fromJSON(env(rowOf('add', group(sym('x')), fence([0]))))).toThrow(/fence\.open/); // the group has its own close
    expect(fromJSON(env(rowOf('add', sym('x'), fence())))).toBeDefined();
    expect(() => fromJSON(env(rowOf('add', sym('x'), { type: 'fence', side: 'open' })))).toThrow(/side/);
    expect(() => fromJSON(env(rowOf('add', sym('x'), { type: 'fence', side: 'close', open: 5 })))).toThrow(/open/);
    expect(() =>
      fromJSON(env({ type: 'group', parens: 'always', child: sym('x'), close: 'no' } as unknown as NodeJson)),
    ).toThrow(/close/);
  });
});

describe('fence tokens flow through the TS class API', () => {
  it('FenceNode serializes, pairs, renders, and is never a value', () => {
    const paired = new FenceNode(['num']);
    expect(paired.toMathML()).toBe('<math><mo fence="true">)</mo></math>');
    expect(() => paired.toMathNode()).toThrow(/incomplete/);
    expect(isEvaluable(paired)).toBe(false);
    const open = new GroupNode(new SymbolNode('x'), false);
    expect(isEvaluable(open)).toBe(false);
    expect(() => open.toMathNode()).toThrow(/closing fence/);
    const unclosed = new FunctionNode('sin', [new SymbolNode('x')], false);
    expect(() => unclosed.toMathNode()).toThrow(/closing fence/);
  });
});

// ——— 4. The implicit marker (glyph-less juxtaposition) ———

describe('implicit multiply rows: glyph-less rendering, evaluation, refusal, S-098 seam', () => {
  it('renders WITHOUT the × glyph — byte-pinned', () => {
    expect(mathOf(imp(num(5), sym('x')))).toBe('<math><mrow><mn>5</mn><mi>x</mi></mrow></math>');
    expect(mathOf(imp(num(5), group(rowOf('add', sym('a'), sym('b')))))).toBe(
      '<math><mrow><mn>5</mn><mrow><mo fence="true">(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo fence="true">)</mo></mrow></mrow></math>',
    );
  });

  it('explicit multiply keeps its × glyph (the marker is additive, row-scoped)', () => {
    expect(mathOf(rowOf('multiply', num(5), sym('x')))).toBe('<math><mrow><mn>5</mn><mo>×</mo><mi>x</mi></mrow></math>');
  });

  it('`5x` evaluates (number before symbol) — folds like mathjs parses it', () => {
    const ast = fromJSON(env(imp(num(5), sym('x'))))!;
    const scope = { x: 4 };
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate(scope)).toBe(20);
    expect(parse('5x').evaluate(scope)).toBe(20);
  });

  it('`5(a+b)` and number-before-structure evaluate', () => {
    const asGroup = fromJSON(env(imp(num(5), group(rowOf('add', sym('a'), sym('b'))))))!;
    const scope = { a: 1, b: 2 };
    expect(isEvaluable(asGroup)).toBe(true);
    expect(asGroup.toMathNode().evaluate(scope)).toBe(15);
    const asStruct = fromJSON(env(imp(num(5), { type: 'frac', num: sym('a'), den: num(2) })))!;
    expect(isEvaluable(asStruct)).toBe(true);
    expect(asStruct.toMathNode().evaluate(scope)).toBe(2.5);
  });

  it('`x` next to `3` refuses, and `x(a+b)` refuses (annotation, not semantics)', () => {
    const symFirst = fromJSON(env(imp(sym('x'), num(3))))!;
    expect(isEvaluable(symFirst)).toBe(false);
    expect(() => symFirst.toMathNode()).toThrow(/implicit adjacency/);
    const symCall = fromJSON(env(imp(sym('x'), group(rowOf('add', sym('a'), sym('b'))))))!;
    expect(isEvaluable(symCall)).toBe(false);
    expect(() => symCall.toMathNode()).toThrow(/implicit adjacency/);
  });

  it('a longer implicit row refuses at the first illegal pair (symbol mid-row)', () => {
    const mixed = fromJSON(env(imp(num(2), sym('x'), group(sym('a')))))!;
    expect(isEvaluable(mixed)).toBe(false);
  });

  it('number next to number refuses (S-098) AND the seam marker renders between them', () => {
    const numNum = fromJSON(env(imp(num(5), num(3))))!;
    expect(isEvaluable(numNum)).toBe(false);
    expect(() => numNum.toMathNode()).toThrow(/implicit adjacency/);
    expect(mathOf(imp(num(5), num(3)))).toBe(`<math><mrow><mn>5</mn>${SEAM}<mn>3</mn></mrow></math>`);
  });

  it('implicit rows with null cells refuse structurally (incomplete rows never evaluate)', () => {
    const withNull = fromJSON(env({ type: 'op', op: 'multiply', args: [num(5), null], implicit: true }))!;
    expect(isEvaluable(withNull)).toBe(false);
  });

  it('round-trip: the marker survives storage; balanced v1 output stays byte-unchanged otherwise', () => {
    const e = env(imp(num(5), sym('x')));
    expect(toJSON(fromJSON(e)!)).toStrictEqual(e);
    expect(toJSON(fromJSON(e)!)).toStrictEqual({ v: 1, root: { type: 'op', op: 'multiply', args: [num(5), sym('x')], implicit: true } });
  });

  it('the marker is multiply-only: fromJSON rejects it on any other op', () => {
    expect(() => fromJSON(env({ type: 'op', op: 'add', args: [num(1), num(2)], implicit: true }))).toThrow(/implicit/);
  });

  it('number before a unit or function construct evaluates (structures read as structures)', () => {
    const beforeUnit = fromJSON(env(imp(num(2), { type: 'unit', value: num(5), unit: 'mm' })))!;
    const beforeFn = fromJSON(env(imp(num(2), fnJson('sqrt', [num(4)]))))!; // judgment call: fn calls read as structures
    expect(isEvaluable(beforeUnit)).toBe(true);
    expect(isEvaluable(beforeFn)).toBe(true);
    expect(beforeFn.toMathNode().evaluate()).toBe(4);
  });
});

// ——— 5. The empty-slot operator-row projection (math-style evaluation reading) ———

describe('op-row projection: leading/doubled operators read unary; trailing/all-null refuse', () => {
  it('`−x` evaluates as negation; `+x` is the identity', () => {
    const neg = fromJSON(env(rowOf('subtract', null, sym('x'))))!;
    const scope = { x: 3 };
    expect(isEvaluable(neg)).toBe(true);
    expect(neg.toMathNode().evaluate(scope)).toBe(-3);
    expect(parse('-x').evaluate(scope)).toBe(-3);
    const id = fromJSON(env(rowOf('add', null, sym('x'))))!;
    expect(isEvaluable(id)).toBe(true);
    expect(id.toMathNode().evaluate(scope)).toBe(3);
  });

  it('`2−−3` = 5 and `a+b++c` = a+b+c (a doubled operator acts on what follows)', () => {
    const doubled = fromJSON(env(rowOf('subtract', num(2), null, num(3))))!;
    expect(isEvaluable(doubled)).toBe(true);
    expect(doubled.toMathNode().evaluate()).toBe(5);
    expect(parse('2--3').evaluate()).toBe(5);
    const chained = fromJSON(env(rowOf('add', sym('a'), sym('b'), null, sym('c'))))!;
    const scope = { a: 1, b: 2, c: 3 };
    expect(isEvaluable(chained)).toBe(true);
    expect(chained.toMathNode().evaluate(scope)).toBe(6);
    expect(parse('a+b++c').evaluate(scope)).toBe(6);
  });

  it('`−x−y` folds the leading unary into the binary row (leading null + filled cells)', () => {
    const ast = fromJSON(env(rowOf('subtract', null, sym('x'), sym('y'))))!;
    const scope = { x: 1, y: 2 };
    expect(isEvaluable(ast)).toBe(true);
    expect(ast.toMathNode().evaluate(scope)).toBe(-3);
    expect(parse('-x-y').evaluate(scope)).toBe(-3);
  });

  it('`−x+` (trailing null) refuses — the row projects the inner negation but not the trailing glyph', () => {
    const negatedPlus = fromJSON(env(rowOf('add', rowOf('subtract', null, sym('x')), null)))!;
    expect(isEvaluable(negatedPlus)).toBe(false);
    expect(() => negatedPlus.toMathNode()).toThrow(/does not project/);
  });

  it('trailing-null, all-null, and two-consecutive-null rows refuse', () => {
    expect(isEvaluable(fromJSON(env(rowOf('add', num(5), null)))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('subtract', null, sym('x'), null)))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('add', null, null)))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('add')))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('subtract', null)))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('add', sym('a'), null, null, sym('b'))))!)).toBe(false);
  });

  it('cells inside a projecting row must themselves be evaluable (the gate is recursive)', () => {
    expect(isEvaluable(fromJSON(env(rowOf('subtract', null, { type: 'frac', num: null, den: num(2) })))!)).toBe(false);
  });

  it('explicit multiply/divide rows with null cells keep refusing (projection is add/subtract-only)', () => {
    expect(isEvaluable(fromJSON(env(rowOf('multiply', num(5), null)))!)).toBe(false);
    expect(isEvaluable(fromJSON(env(rowOf('divide', num(5), null)))!)).toBe(false);
  });

  it('the stored trees carry NO unary nodes — the projection alone creates them', () => {
    const json = JSON.stringify(toJSON(fromJSON(env(rowOf('subtract', null, sym('x')))))!);
    expect(json).not.toContain('unaryMinus');
    expect(json).not.toContain('unaryPlus');
  });

  it('a walker unaryMinus tree and its projected row equivalent evaluate (and render) identically', () => {
    const asUnary = new OperatorNode('unaryMinus', [new SymbolNode('x')]);
    const asRow = new OperatorNode('subtract', [null, new SymbolNode('x')]);
    const scope = { x: 7 };
    expect(asRow.toMathNode().evaluate(scope)).toBe(asUnary.toMathNode().evaluate(scope));
    expect(asRow.toMathNode().toString()).toBe(asUnary.toMathNode().toString());
    expect(asRow.toMathML()).toBe(asUnary.toMathML());
  });

  it('the unaryPlus mirror: walker node and projected row equivalent render and evaluate identically', () => {
    const asUnary = new OperatorNode('unaryPlus', [new NumberNode(5)]);
    const asRow = new OperatorNode('add', [null, new NumberNode(5)]);
    expect(asRow.toMathNode().evaluate()).toBe(asUnary.toMathNode().evaluate());
    expect(asRow.toMathNode().toString()).toBe(asUnary.toMathNode().toString());
    expect(asRow.toMathML()).toBe(asUnary.toMathML());
  });

  it('filled add/subtract rows are unchanged: evaluable, plain left fold', () => {
    const plain = fromJSON(env(rowOf('add', num(5), num(3))))!;
    expect(isEvaluable(plain)).toBe(true);
    expect(plain.toMathNode().evaluate()).toBe(8);
  });
});

// ——— 6. The in-progress trailing decimal point (T4/S-012, session 2a) ———

describe('the num dot state: storable, renders `5.`, evaluates as its value', () => {
  const dotted = (value: number): NodeJson => ({ type: 'num', value, dot: true });

  it('renders the trailing dot and round-trips byte-stably (envelope v1, emitted only when set)', () => {
    expect(mathOf(dotted(5))).toBe('<math><mn>5.</mn></math>');
    const e = env(dotted(5));
    expect(toJSON(fromJSON(e)!)).toStrictEqual(e);
    // balanced v1 output stays byte-unchanged (no dot field when false)
    expect(toJSON(fromJSON(env(num(5)))!)).toStrictEqual({ v: 1, root: num(5) });
  });

  it('owner ruling: a dotted number EVALUATES as its numeric value (`5.` = 5) — mathjs parity', () => {
    const ast = fromJSON(env(dotted(5)))!;
    expect(isEvaluable(ast)).toBe(true); // isEvaluable unaffected by the flag
    expect(ast.toMathNode().evaluate()).toBe(5);
    expect(parse('5.').evaluate()).toBe(5);
    // the `0.` auto-prefix state evaluates as 0
    expect(fromJSON(env(dotted(0)))!.toMathNode().evaluate()).toBe(0);
  });

  it('fromJSON validates the field shape (booleans only)', () => {
    expect(() => fromJSON(env({ type: 'num', value: 5, dot: 1 } as unknown as NodeJson))).toThrow(/dot/);
    expect(() => fromJSON(env({ type: 'num', value: 5, dot: 'yes' } as unknown as NodeJson))).toThrow(/dot/);
  });

  it('the trailing dot is part of the in-token text (caret offsets address it)', () => {
    // `0.` has length 2 — the T4 caret "inside the number, after the dot"
    // sits at offset 2, legal token-carry data
    expect(caretResolvesIn(env(dotted(0)), { kind: 'token', path: [], index: 2 })).toBe(true);
    expect(caretResolvesIn(env(dotted(0)), { kind: 'token', path: [], index: 3 })).toBe(false);
  });
});

// ——— 7. The widened pair rule: group-before-X (ruled 2026-11-08) ———

describe('widened juxtaposition pairing: group-before-X evaluates, like number-before-X', () => {
  it('(a+b)x evaluates as (a+b)*x; (a+b)(c+d) evaluates too (right side non-num)', () => {
    const g = fromJSON(env(imp(group(rowOf('add', sym('a'), sym('b'))), sym('x'))))!;
    const scope = { a: 1, b: 2, x: 4 };
    expect(isEvaluable(g)).toBe(true);
    expect(g.toMathNode().evaluate(scope)).toBe(12);
    const gg = fromJSON(env(imp(group(rowOf('add', sym('a'), sym('b'))), group(rowOf('add', sym('c'), sym('d'))))))!;
    const scope2 = { a: 2, b: 3, c: 4, d: 5 };
    expect(isEvaluable(gg)).toBe(true);
    expect(gg.toMathNode().evaluate(scope2)).toBe(45);
  });

  it('group-before-NUMBER still refuses (the literal mirror of the number rule: the right cell must not be a number)', () => {
    const gn = fromJSON(env(imp(group(rowOf('add', sym('a'), sym('b'))), num(3))))!;
    expect(isEvaluable(gn)).toBe(false);
    expect(() => gn.toMathNode()).toThrow(/implicit adjacency/);
  });

  it('the single shared predicate drives gate + fold: symbol-before-X and number-number still refuse', () => {
    const sx = fromJSON(env(imp(sym('x'), group(rowOf('add', sym('a'), sym('b'))))))!;
    expect(isEvaluable(sx)).toBe(false);
    expect(() => sx.toMathNode()).toThrow(/implicit adjacency/);
    const nn = fromJSON(env(imp(num(5), num(3))))!;
    expect(isEvaluable(nn)).toBe(false);
  });
});
