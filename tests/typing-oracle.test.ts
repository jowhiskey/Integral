// The math.parse typing oracle (arc session 3): for any linear typing
// sequence, simulating the keystrokes through the policy must produce the
// tree math.parse builds from the same expression — compared through the
// test-side canonicalizer (mathjs's nested same-op trees fold into our flat
// chain form, on BOTH sides; divide and pow never fold). Integration runs
// at every parseable prefix, not just the final result; a prefix that
// parses while the typed tree is incomplete (or differs) is a red test. The
// normalizer lives here, never in the engine; any drift is a failure, never
// a weakening.

import { describe, expect, it } from 'vitest';
import { parse } from 'mathjs';
import type { NodeJson } from '../src/ast/index.js';
import { envelopeOf } from '../src/engine/index.js';
import { CORPUS, canonAst, canonMath, compareAgainstParse, lexPrefixes, typeSource } from './typing-support.js';

function canonAstFrom(state: ReturnType<typeof typeSource>): ReturnType<typeof canonAst> {
  return canonAst((JSON.parse(JSON.stringify(envelopeOf(state))) as { root: NodeJson | null }).root);
}

describe('typing oracle: policy AST ≡ math.parse through the chain normalizer', () => {
  it('every corpus source matches mathjs at the final (complete) state', () => {
    for (const source of CORPUS) {
      const state = typeSource(source);
      const theirs = canonMath(parse(source));
      expect({ source, tree: canonAstFrom(state) }).toEqual({ source, tree: theirs });
    }
  });

  it('every parseable PREFIX matches mathjs at that point in the typing sequence', () => {
    for (const source of CORPUS) {
      const compared = compareAgainstParse(source);
      expect(compared, source).toBeGreaterThan(0);
    }
  });

  it('prefix bookkeeping: the final prefix is the full source', () => {
    for (const source of CORPUS) {
      expect(lexPrefixes(source).pop()).toBe(source);
    }
  });
});

// ——— The normalizer is honest: negative pins ———

describe('normalizer negative pins (it folds chains, nothing else)', () => {
  it('folds mathjs left-nested add chains: 1+2+3 → one chain of three', () => {
    expect(canonMath(parse('1+2+3'))).toEqual({
      k: 'chain',
      op: 'add',
      args: [
        { k: 'num', v: 1 },
        { k: 'num', v: 2 },
        { k: 'num', v: 3 },
      ],
    });
  });

  it('never folds divide: 8/4/2 keeps its left nesting on both shapes', () => {
    expect(canonMath(parse('8/4/2'))).toEqual({
      k: 'op',
      op: 'divide',
      args: [
        { k: 'op', op: 'divide', args: [{ k: 'num', v: 8 }, { k: 'num', v: 4 }] },
        { k: 'num', v: 2 },
      ],
    });
  });

  it('never folds pow: 2^3^4 keeps its right nesting', () => {
    expect(canonMath(parse('2^3^4'))).toEqual({
      k: 'op',
      op: 'pow',
      args: [
        { k: 'num', v: 2 },
        { k: 'op', op: 'pow', args: [{ k: 'num', v: 3 }, { k: 'num', v: 4 }] },
      ],
    });
  });

  it('a group is structural, not an artifact: (1+2) keeps its group wrapper', () => {
    expect(canonMath(parse('(1+2)*3'))).toEqual({
      k: 'chain',
      op: 'multiply',
      args: [
        { k: 'group', child: { k: 'chain', op: 'add', args: [{ k: 'num', v: 1 }, { k: 'num', v: 2 }] } },
        { k: 'num', v: 3 },
      ],
    });
  });

  it('a wrong attach produces a red oracle, not a pass: nest vs wrap distinguish', () => {
    // If the policy wrapped instead of nesting at a+b*, the typed shape
    // would be multiply(add(a,b), …) — assert the oracle can see the
    // difference against the real mathjs tree.
    const right = canonMath(parse('a+b*c'));
    expect(right).toEqual({
      k: 'chain',
      op: 'add',
      args: [
        { k: 'sym', n: 'a' },
        { k: 'chain', op: 'multiply', args: [{ k: 'sym', n: 'b' }, { k: 'sym', n: 'c' }] },
      ],
    });
    const wrongShape = {
      k: 'chain',
      op: 'multiply',
      args: [
        { k: 'chain', op: 'add', args: [{ k: 'sym', n: 'a' }, { k: 'sym', n: 'b' }] },
        { k: 'sym', n: 'c' },
      ],
    };
    expect(wrongShape).not.toEqual(right);
  });
});
