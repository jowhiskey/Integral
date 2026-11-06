import { describe, expect, it } from 'vitest';
import {
  FractionNode,
  FunctionNode,
  GroupNode,
  MathNode,
  NumberNode,
  OperatorNode,
  PowerNode,
  RootNode,
  SubscriptNode,
  SymbolNode,
  UnitNode,
  fromJSON,
  isEvaluable,
  toMathML,
} from '../src/ast/index.js';

const M = String.raw;

describe('toMathML: format anchors (spec-pinned output shapes)', () => {
  it('n-ary add renders a flat mrow: a+b+c', () => {
    const ast = new OperatorNode('add', [new SymbolNode('a'), new SymbolNode('b'), new SymbolNode('c')]);
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mi>a</mi><mo>+</mo><mi>b</mi><mo>+</mo><mi>c</mi></mrow></math>`,
    );
  });

  it('subscript renders msub: x_max', () => {
    expect(new SubscriptNode('x', 'max').toMathML()).toBe(
      M`<math><msub><mi>x</mi><mi>max</mi></msub></math>`,
    );
  });

  it('unit renders upright symbol with thin mspace: 50 mm', () => {
    expect(new UnitNode(new NumberNode(50), 'mm').toMathML()).toBe(
      M`<math><mrow><mn>50</mn><mspace width="0.1667em"/><mi mathvariant="normal">mm</mi></mrow></math>`,
    );
  });

  it('fenced numerator group renders exactly where the tree has a GroupNode: (5+4*3)/2', () => {
    // frac(num: group(op[+](5, op[*](4,3))), den: 2)
    const ast = new FractionNode(
      new GroupNode(new OperatorNode('add', [new NumberNode(5), new OperatorNode('multiply', [new NumberNode(4), new NumberNode(3)])])),
      new NumberNode(2),
    );
    expect(ast.toMathML()).toBe(
      M`<math><mfrac><mrow><mo fence="true">(</mo><mn>5</mn><mo>+</mo><mrow><mn>4</mn><mo>×</mo><mn>3</mn></mrow><mo fence="true">)</mo></mrow><mn>2</mn></mfrac></math>`,
    );
  });
});

describe('toMathML: structural rendering per node type', () => {
  it('NumberNode → mn', () => {
    expect(new NumberNode(5).toMathML()).toBe(M`<math><mn>5</mn></math>`);
    expect(new NumberNode(-3.5).toMathML()).toBe(M`<math><mn>-3.5</mn></math>`);
    expect(new NumberNode(6.02e23).toMathML()).toBe(M`<math><mn>6.02e+23</mn></math>`);
  });

  it('NumberNode normalizes -0 (JSON contract cannot carry the sign)', () => {
    expect(new NumberNode(-0).toMathML()).toBe(M`<math><mn>0</mn></math>`);
  });

  it('SymbolNode → mi', () => {
    expect(new SymbolNode('E').toMathML()).toBe(M`<math><mi>E</mi></math>`);
  });

  it('OperatorNode renders the displayed glyph per operator', () => {
    const two = new OperatorNode('multiply', [new NumberNode(4), new NumberNode(3)]);
    expect(two.toMathML()).toContain(M`<mo>×</mo>`);
    expect(new OperatorNode('subtract', [new NumberNode(4), new NumberNode(3)]).toMathML()).toContain(M`<mo>−</mo>`);
    expect(new OperatorNode('divide', [new NumberNode(4), new NumberNode(3)]).toMathML()).toContain(M`<mo>/</mo>`);
    expect(new OperatorNode('mod', [new NumberNode(4), new NumberNode(3)]).toMathML()).toContain(M`<mo>mod</mo>`);
  });

  it('unary minus renders as prefix, no mrow around the operand alone', () => {
    expect(new OperatorNode('unaryMinus', [new NumberNode(5)]).toMathML()).toBe(
      M`<math><mrow><mo>−</mo><mn>5</mn></mrow></math>`,
    );
  });

  it('FunctionNode renders name + fenced args, commas between args: max(a, 2)', () => {
    const ast = new FunctionNode('max', [new SymbolNode('a'), new NumberNode(2)]);
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mi>max</mi><mo fence="true">(</mo><mi>a</mi><mo>,</mo><mn>2</mn><mo fence="true">)</mo></mrow></math>`,
    );
  });

  it('GroupNode renders one fenced mrow: (5+3)', () => {
    const ast = new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)]));
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mo fence="true">(</mo><mn>5</mn><mo>+</mo><mn>3</mn><mo fence="true">)</mo></mrow></math>`,
    );
  });

  it('FractionNode → mfrac', () => {
    expect(new FractionNode(new NumberNode(1), new NumberNode(2)).toMathML()).toBe(
      M`<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>`,
    );
  });

  it('PowerNode → msup', () => {
    expect(new PowerNode(new NumberNode(2), new NumberNode(3)).toMathML()).toBe(
      M`<math><msup><mn>2</mn><mn>3</mn></msup></math>`,
    );
  });

  it('RootNode: omitted/null index → msqrt', () => {
    expect(new RootNode(new NumberNode(16)).toMathML()).toBe(M`<math><msqrt><mn>16</mn></msqrt></math>`);
    expect(new RootNode(new NumberNode(16), null).toMathML()).toBe(M`<math><msqrt><mn>16</mn></msqrt></math>`);
  });

  it('RootNode: index present → mroot', () => {
    expect(new RootNode(new NumberNode(16), new NumberNode(3)).toMathML()).toBe(
      M`<math><mroot><mn>16</mn><mn>3</mn></mroot></math>`,
    );
  });

  it('a 2-arg pow op displays exactly like PowerNode (stored-legal shape)', () => {
    const asOp = new OperatorNode('pow', [new NumberNode(2), new NumberNode(3)]);
    const asPower = new PowerNode(new NumberNode(2), new NumberNode(3));
    expect(asOp.toMathML()).toBe(asPower.toMathML());
  });

  it('zero-arg fn renders empty fences — complete tree (host zero-arg functions are legal)', () => {
    expect(new FunctionNode('rand', []).toMathML()).toBe(
      M`<math><mrow><mi>rand</mi><mo fence="true">(</mo><mo fence="true">)</mo></mrow></math>`,
    );
  });

  it('unknown op names (host-built junk) render their name — never throw', () => {
    const ast = new OperatorNode('frob', [new SymbolNode('a'), new SymbolNode('b')]);
    expect(ast.toMathML()).toBe(M`<math><mrow><mi>a</mi><mo>frob</mo><mi>b</mi></mrow></math>`);
  });

  it('TS-only edge shapes never throw: empty args, 1-arg pow op, 3-arg pow op', () => {
    expect(new OperatorNode('add', []).toMathML()).toBe(M`<math><mrow><mi>□</mi></mrow></math>`);
    expect(new OperatorNode('pow', [new SymbolNode('x')]).toMathML()).toBe(
      M`<math><msup><mi>x</mi><mi>□</mi></msup></math>`,
    );
    expect(new OperatorNode('pow', [new NumberNode(2), new NumberNode(3), new NumberNode(4)]).toMathML()).toContain(
      M`<mo>^</mo>`,
    );
  });
});

describe('toMathML: incomplete trees render, never throw (display, not evaluation)', () => {
  const SLOT = '<mi>□</mi>';

  it('null slots render a visible placeholder', () => {
    expect(new GroupNode(null).toMathML()).toBe(
      M`<math><mrow><mo fence="true">(</mo>${SLOT}<mo fence="true">)</mo></mrow></math>`,
    );
    expect(new FractionNode(null, null).toMathML()).toBe(
      M`<math><mfrac>${SLOT}${SLOT}</mfrac></math>`,
    );
    expect(new PowerNode(null, null).toMathML()).toBe(
      M`<math><msup>${SLOT}${SLOT}</msup></math>`,
    );
    expect(new RootNode(null, null).toMathML()).toBe(
      M`<math><msqrt>${SLOT}</msqrt></math>`,
    );
    expect(new OperatorNode('add', [new NumberNode(5), null]).toMathML()).toBe(
      M`<math><mrow><mn>5</mn><mo>+</mo>${SLOT}</mrow></math>`,
    );
    expect(new UnitNode(null, 'mm').toMathML()).toBe(
      M`<math><mrow>${SLOT}<mspace width="0.1667em"/><mi mathvariant="normal">mm</mi></mrow></math>`,
    );
  });

  it('empty-string fields render empty (string fields, not slot placeholders)', () => {
    expect(new SymbolNode('').toMathML()).toBe(M`<math><mi></mi></math>`);
    expect(new FunctionNode('', [new NumberNode(1)]).toMathML()).toContain(M`<mi></mi><mo fence="true">(</mo>`);
    expect(new SubscriptNode('', '').toMathML()).toBe(M`<math><msub><mi></mi><mi></mi></msub></math>`);
    // empty unit: empty upright mi, and no separator (nothing to separate)
    expect(new UnitNode(new NumberNode(50), '').toMathML()).toBe(
      M`<math><mrow><mn>50</mn><mi mathvariant="normal"></mi></mrow></math>`,
    );
  });

  it('the legal-envelope corpus renders through fromJSON without throwing (pins)', () => {
    const cases: [string, unknown, string][] = [
      [
        'dangling op 5+',
        { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'num', value: 5 }, null] } },
        M`<math><mrow><mn>5</mn><mo>+</mo><mi>□</mi></mrow></math>`,
      ],
      [
        'empty fraction',
        { v: 1, root: { type: 'frac', num: null, den: null } },
        M`<math><mfrac><mi>□</mi><mi>□</mi></mfrac></math>`,
      ],
      [
        'empty group',
        { v: 1, root: { type: 'group', parens: 'always', child: null } },
        M`<math><mrow><mo fence="true">(</mo><mi>□</mi><mo fence="true">)</mo></mrow></math>`,
      ],
      [
        'omitted root.index renders the square-root form',
        { v: 1, root: { type: 'root', radicand: { type: 'num', value: 16 } } },
        M`<math><msqrt><mn>16</mn></msqrt></math>`,
      ],
      [
        'explicit null root.index renders the square-root form',
        { v: 1, root: { type: 'root', radicand: { type: 'num', value: 16 }, index: null } },
        M`<math><msqrt><mn>16</mn></msqrt></math>`,
      ],
      [
        'incomplete pow op [x, null]',
        { v: 1, root: { type: 'op', op: 'pow', args: [{ type: 'sym', name: 'x' }, null] } },
        M`<math><msup><mi>x</mi><mi>□</mi></msup></math>`,
      ],
      [
        'empty sym name',
        { v: 1, root: { type: 'sym', name: '' } },
        M`<math><mi></mi></math>`,
      ],
      [
        'empty fn name, one null arg',
        { v: 1, root: { type: 'fn', name: '', args: [null] } },
        M`<math><mrow><mi></mi><mo fence="true">(</mo><mi>□</mi><mo fence="true">)</mo></mrow></math>`,
      ],
      [
        'empty sub labels',
        { v: 1, root: { type: 'sub', base: '', sub: '' } },
        M`<math><msub><mi></mi><mi></mi></msub></math>`,
      ],
      [
        'empty unit name (pinned incomplete-state exception)',
        { v: 1, root: { type: 'unit', value: { type: 'num', value: 50 }, unit: '' } },
        M`<math><mrow><mn>50</mn><mi mathvariant="normal"></mi></mrow></math>`,
      ],
      [
        'missing content slots treated as null',
        { v: 1, root: { type: 'frac' } },
        M`<math><mfrac><mi>□</mi><mi>□</mi></mfrac></math>`,
      ],
    ];
    for (const [label, envelope, expected] of cases) {
      const ast = fromJSON(envelope);
      expect(toMathML(ast), label).toBe(expected);
    }
  });

  it('the unit value slot composes: (5+3) mm keeps the group fence and the thin space', () => {
    const ast = new UnitNode(
      new GroupNode(new OperatorNode('add', [new NumberNode(5), new NumberNode(3)])),
      'mm',
    );
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mrow><mo fence="true">(</mo><mn>5</mn><mo>+</mo><mn>3</mn><mo fence="true">)</mo></mrow><mspace width="0.1667em"/><mi mathvariant="normal">mm</mi></mrow></math>`,
    );
  });

  it('a unit embedded in an n-ary row sits flat: 2 + 50 mm', () => {
    const ast = new OperatorNode('add', [
      new NumberNode(2),
      new UnitNode(new NumberNode(50), 'mm'),
    ]);
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mn>2</mn><mo>+</mo><mn>50</mn><mspace width="0.1667em"/><mi mathvariant="normal">mm</mi></mrow></math>`,
    );
  });

  it('isEvaluable plays no role in rendering (same code path either way)', () => {
    const evaluable: MathNode = new FunctionNode('sqrt', [new NumberNode(16), new NumberNode(9)]);
    const notEvaluable: MathNode = new UnitNode(new NumberNode(1), '');
    const render = (ast: MathNode): string => ast.toMathML();
    expect(isEvaluable(evaluable)).toBe(true);
    expect(isEvaluable(notEvaluable)).toBe(false);
    expect(() => render(evaluable)).not.toThrow();
    expect(() => render(notEvaluable)).not.toThrow();
  });

  it('the empty formula renders as the empty string', () => {
    expect(toMathML(null)).toBe('');
    expect(toMathML(fromJSON({ v: 1, root: null }))).toBe('');
    expect(toMathML(fromJSON({ v: 1 }))).toBe('');
  });
});

describe('toMathML: precedence is structural (fences only where GroupNode is)', () => {
  const built_precedence = (): MathNode =>
    new OperatorNode('add', [
      new NumberNode(5),
      new OperatorNode('multiply', [new NumberNode(4), new NumberNode(3)]),
    ]);

  it('5+4*3 renders no fences', () => {
    expect(built_precedence().toMathML()).not.toContain('fence');
    expect(built_precedence().toMathML()).toBe(
      M`<math><mrow><mn>5</mn><mo>+</mo><mrow><mn>4</mn><mo>×</mo><mn>3</mn></mrow></mrow></math>`,
    );
  });

  it('(5+4*3)/2 renders the numerator fence exactly once', () => {
    const ast = new FractionNode(
      new GroupNode(new OperatorNode('add', [new NumberNode(5), new OperatorNode('multiply', [new NumberNode(4), new NumberNode(3)])])),
      new NumberNode(2),
    );
    const mathml = ast.toMathML();
    expect(mathml.split('fence="true"').length - 1).toBe(2); // one ( and one ) — exactly once
    expect(mathml).toBe(
      M`<math><mfrac><mrow><mo fence="true">(</mo><mn>5</mn><mo>+</mo><mrow><mn>4</mn><mo>×</mo><mn>3</mn></mrow><mo fence="true">)</mo></mrow><mn>2</mn></mfrac></math>`,
    );
  });

  it('same-op chains render flat: n-ary args, one mrow, n-1 separator mo', () => {
    const chain = new OperatorNode('multiply', [
      new SymbolNode('a'),
      new SymbolNode('b'),
      new SymbolNode('c'),
      new SymbolNode('d'),
    ]);
    const mathml = chain.toMathML();
    expect((mathml.match(/<mrow>/g) ?? []).length).toBe(1);
    expect((mathml.match(/<mo>×<\/mo>/g) ?? []).length).toBe(3);
  });

  it('a group inside the fence renders, a group nested in op renders — structure, not derivation', () => {
    // ((5)) = group(group(5))
    const ast = new GroupNode(new GroupNode(new NumberNode(5)));
    expect(ast.toMathML()).toBe(
      M`<math><mrow><mo fence="true">(</mo><mrow><mo fence="true">(</mo><mn>5</mn><mo fence="true">)</mo></mrow><mo fence="true">)</mo></mrow></math>`,
    );
  });
});

describe('toMathML: text escaping (host-provided strings are untrusted)', () => {
  it('escapes &, <, > in identifiers, names, and unit strings', () => {
    expect(new SymbolNode('a<b&c>d').toMathML()).toBe(M`<math><mi>a&lt;b&amp;c&gt;d</mi></math>`);
    const viaJson = fromJSON({ v: 1, root: { type: 'sym', name: '<script>' } });
    expect(toMathML(viaJson)).toBe(M`<math><mi>&lt;script&gt;</mi></math>`);
  });

  it('escaped output stays well-formed single-element markup (scanner round trip)', () => {
    const ast = new SymbolNode('a<b');
    const mathml = ast.toMathML();
    expect(mathml).toBe(M`<math><mi>a&lt;b</mi></math>`);
    expect((mathml.match(/<mi>/g) ?? []).length).toBe(1); // the escaped '<' opens no tag
  });
});
