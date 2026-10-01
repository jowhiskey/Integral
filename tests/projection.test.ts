// Projection (toMathNode) regression tests, ported from the adversarial
// audit: fold/oracle equivalence, display parity, unit-projection equivalence
// over the whole default vocabulary, and the unary channel. The n-ary pow
// cases are adapted to the decided semantics (reject >2-arg chains at the
// boundary instead of folding them).

import { describe, expect, it } from 'vitest';
import { parse, Unit } from 'mathjs';
import {
  defaultStaticVocabulary,
  fromJSON,
  isEvaluable,
} from '../src/ast/index.js';

/** Oracle: the AST fold must match mathjs's own parse of the equivalent expression. */
function expectFoldMatchesOracle(ast: { toMathNode: () => { evaluate: () => unknown } }, equivalentSource: string) {
  const oracle = parse(equivalentSource).evaluate();
  const folded = ast.toMathNode().evaluate();
  expect(folded).toEqual(oracle);
}

describe('n-ary pow chains have no ambiguous fold (decided: rejected at the boundary)', () => {
  it('a three-arg pow chain is not a legal stored shape', () => {
    // The audit asserted both right-association and a toMathNode throw; the
    // decided pick rejects the shape at fromJSON — no editor path produces
    // it, and a fold (either direction) would legitimize a shape no mathjs
    // user can type.
    const root = {
      type: 'op',
      op: 'pow',
      args: [{ type: 'num', value: 2 }, { type: 'num', value: 3 }, { type: 'num', value: 4 }],
    };
    expect(() => fromJSON({ v: 1, root })).toThrow(/unambiguous association/);
  });
});

describe('structural precedence survives the fold', () => {
  const grouped = {
    v: 1 as const,
    root: {
      type: 'op',
      op: 'multiply',
      args: [
        { type: 'op', op: 'subtract', args: [{ type: 'num', value: 5 }, { type: 'num', value: 3 }] },
        { type: 'num', value: 2 },
      ],
    },
  };

  it('grouped subtraction under multiply folds with the group visible in evaluation', () => {
    const ast = fromJSON(grouped)!;
    // 5-3*2 in text is -1; structurally the AST is (5-3)*2 = 4. The fold
    // carries the args, so evaluation agrees with the structure.
    expectFoldMatchesOracle(ast, '(5 - 3) * 2');
  });

  it('the folded tree toString() re-parses to the same value (display parity)', () => {
    const ast = fromJSON(grouped)!;
    const displayed = ast.toMathNode().toString();
    // Pins that the emitted tree still evaluates to the structural value
    // even after a display round-trip — regression guard against string-
    // based re-parse drifting from the fold.
    expect(parse(displayed).evaluate()).toBe(4);
  });
});

describe('subscript projection stays inside the symbol channel', () => {
  it('a hostile base label is rejected at the boundary, not smuggled into display', () => {
    // sub('a+b', 'c') projected to SymbolNode('a+b_c'), whose display
    // re-parses as addition — render/eval divergence through an unvalidated
    // name channel.
    expect(() => fromJSON({ v: 1, root: { type: 'sub', base: 'a+b', sub: 'c' } })).toThrow();
  });

  it('a legal subscript display re-parses to the same symbol and value', () => {
    const ast = fromJSON({ v: 1, root: { type: 'sub', base: 'a', sub: 'c' } })!;
    const folded = ast.toMathNode();
    const displayed = folded.toString();
    const scope = { a_c: 7, a: 1, c: 1 };
    expect(parse(displayed).evaluate(scope)).toEqual(folded.evaluate(scope));
    expect(parse(displayed).evaluate(scope)).toBe(7);
  });
});

describe('UnitNode projection matches the mathjs parse for every default unit', () => {
  it('every unit string fromJSON accepts folds identically to parsing "5 <unit>"', () => {
    // The frozen projection's own equivalence claim, swept over the whole
    // default vocabulary — no skip list: parser-shadowed entries (chain,
    // min, sec) are no longer in the list at all.
    for (const unit of defaultStaticVocabulary.units) {
      const ast = fromJSON({ v: 1, root: { type: 'unit', value: { type: 'num', value: 5 }, unit } })!;
      const folded = ast.toMathNode().evaluate();
      const oracle = parse(`5 ${unit}`).evaluate();
      if (oracle instanceof Unit) {
        expect(folded, `unit "${unit}" fold matches mathjs parse`).toBeInstanceOf(Unit);
        expect(String(folded), `unit "${unit}"`).toBe(String(oracle));
      } else {
        expect(folded, `unit "${unit}" fold matches mathjs parse`).toEqual(oracle);
      }
    }
  });

  it('every accepted unit is evaluable (no validation/evaluation disagreement)', () => {
    for (const unit of ['mm', 'km', 'degC', 'us']) {
      const ast = fromJSON({ v: 1, root: { type: 'unit', value: { type: 'num', value: 5 }, unit } })!;
      expect(isEvaluable(ast), unit).toBe(true);
      expect(ast.toMathNode().evaluate()).toBeInstanceOf(Unit);
    }
  });
});

describe('unary operator channel', () => {
  it('unaryMinus folds to a mathjs tree whose display matches its evaluation', () => {
    const ast = fromJSON({ v: 1, root: { type: 'op', op: 'unaryMinus', args: [{ type: 'num', value: 5 }] } })!;
    const folded = ast.toMathNode();
    expect(folded.toString()).toBe('-5');
  });

  it('double unaryMinus chains through a group fold deterministically', () => {
    const ast = fromJSON({
      v: 1,
      root: {
        type: 'op',
        op: 'unaryMinus',
        args: [{ type: 'group', parens: 'always', child: { type: 'op', op: 'unaryMinus', args: [{ type: 'num', value: 5 }] } }],
      },
    })!;
    expect(ast.toMathNode().evaluate()).toBe(5);
  });
});
