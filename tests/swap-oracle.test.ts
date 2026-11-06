// The swap oracle (arc session 4): typed insertion vs swap-edit of the same
// expression must yield identical ASTs — the session-3 math.parse oracle
// extended over swaps. For every (operand count, operator pattern, position,
// replacement op): type the original source, navigate to operator i, swap it
// to the new op, and require the swapped tree ≡ the same expression typed
// directly ≡ math.parse of that expression. Precedence ties (where editors
// diverge from CAS expectations) are covered exhaustively; ×↔÷ and ^ ride
// the same loop. Every swapped state must also pass the fromJSON gate with
// a resolving caret.

import { describe, expect, it } from 'vitest';
import { parse } from 'mathjs';
import { fromJSON, type NodeJson } from '../src/ast/index.js';
import {
  applyOp,
  caretResolves,
  envelopeOf,
  typeToken,
  type Caret,
  type EditingState,
} from '../src/engine/index.js';
import { canonAst, canonMath, typeSource } from './typing-support.js';

const ROW_OPS = ['+', '-', '*', 'mod'] as const;
const NEW_OPS = ['+', '-', '*', 'mod', '/', '^'] as const;
const OPERANDS = ['a', 'b', 'c', 'd', 'e'];

const tokenOf = (glyph: string) =>
  glyph === '/'
    ? { t: 'divide' }
    : glyph === '^'
      ? { t: 'pow' }
      : { t: 'operator', fn: glyph === '+' ? 'add' : glyph === '-' ? 'subtract' : glyph === '*' ? 'multiply' : 'mod' };

const sourceOf = (glyphs: readonly string[], operands: readonly string[] = OPERANDS): string => {
  const out: string[] = [operands[0]];
  glyphs.forEach((g, i) => {
    out.push(` ${g} `, operands[i + 1]);
  });
  return out.join('');
};

const reGlyph = (glyphs: readonly string[], at: number, withGlyph: string): string[] =>
  glyphs.map((g, i) => (i === at ? withGlyph : g));

const rootOf = (state: EditingState): NodeJson | null =>
  (JSON.parse(JSON.stringify(envelopeOf(state))) as { root: NodeJson | null }).root;
const canonOf = (state: EditingState): ReturnType<typeof canonAst> => canonAst(rootOf(state));

/** One caret per source-level operator of the typed tree, in source binding
 *  order: flat-chain glyphs at row seams, sub-row operators interleaved
 *  where they sit, frac slots descended. */
function operatorCarets(root: NodeJson | null): Caret[] {
  const out: Caret[] = [];
  const walk = (node: NodeJson | null, path: (number | string)[]): void => {
    if (node === null) return;
    switch (node.type) {
      case 'op':
      case 'fn': {
        const args = node.args;
        for (let k = 0; k < args.length; k++) {
          walk(args[k], [...path, k]);
          if (k < args.length - 1 && node.type === 'op') {
            out.push({ kind: 'row', path, index: k + 1 });
          }
        }
        break;
      }
      case 'group':
        walk(node.child, [...path, 'child']);
        break;
      case 'frac':
        walk(node.num, [...path, 'num']);
        walk(node.den, [...path, 'den']);
        break;
      case 'pow':
        walk(node.base, [...path, 'base']);
        walk(node.exp, [...path, 'exp']);
        break;
      default:
        break; // num, sym, sub: no operator positions inside
    }
  };
  walk(root, []);
  return out;
}

/** Exhaustive / seeded operator patterns of length k over ROW_OPS. */
function patterns(k: number, stride = 1): string[][] {
  const out: string[][] = [];
  const total = ROW_OPS.length ** k;
  for (let n = 0; n < total; n += stride) {
    const glyphs: string[] = [];
    let v = n;
    for (let d = 0; d < k; d++) {
      glyphs.push(ROW_OPS[v % ROW_OPS.length]);
      v = Math.floor(v / ROW_OPS.length);
    }
    out.push(glyphs);
  }
  return out;
}

/** The triple oracle: swap-edit ≡ typed insertion ≡ math.parse — plus
 *  fromJSON legality and caret validity at the swapped state. */
function assertSwapEquivalence(orig: string, target: string, pos: Caret, newGlyph: string): void {
  const seed = typeSource(orig);
  const moved = applyOp(seed, { op: 'moveCaret', to: pos });
  const swapped = typeToken(moved, tokenOf(newGlyph));
  const got = canonOf(swapped);
  expect({ target, got }).toEqual({ target, got: canonOf(typeSource(target)) });
  expect({ target, got }).toEqual({ target, got: canonMath(parse(target)) });
  expect(() => fromJSON(envelopeOf(swapped))).not.toThrow();
  expect(caretResolves(fromJSON(envelopeOf(swapped)), swapped.caret)).toBe(true);
}

/** One full (pattern × position × replacement) sweep over `glyphs`. */
let caseCount = 0;
function sweep(glyphs: readonly string[]): void {
  const orig = sourceOf(glyphs);
  const carets = operatorCarets(rootOf(typeSource(orig)));
  expect(carets.length, orig).toBe(glyphs.length); // harness: one caret per source op
  caseCount += glyphs.length * NEW_OPS.length;
  for (let i = 0; i < glyphs.length; i++) {
    for (const g of NEW_OPS) {
      assertSwapEquivalence(orig, sourceOf(reGlyph(glyphs, i, g)), carets[i], g);
    }
  }
}

describe('swap oracle: swap-edit ≡ typed insertion ≡ math.parse', () => {
  it('binary chains — every operator × every replacement', () => {
    for (const glyphs of patterns(1)) sweep(glyphs);
  });

  it('3 operands — exhaustive patterns, both operator positions, ties included', () => {
    for (const glyphs of patterns(2)) sweep(glyphs);
  });

  it('4 operands — exhaustive: the ripples (splits, merges, parent re-folds)', () => {
    for (const glyphs of patterns(3)) sweep(glyphs);
  });

  it('5 operands — sampled sweeps (32 patterns, all positions)', () => {
    for (const glyphs of patterns(4, 8)) sweep(glyphs);
  });

  it('corpus size honesty: the sweeps really ran the full case matrix', () => {
    // (4×1 + 16×2 + 64×3 + 32×4) patterns×positions, each × 6 replacements.
    expect(caseCount).toBe((4 * 1 + 16 * 2 + 64 * 3 + 32 * 4) * 6);
  });
});

// ——— Oracle honesty: negative pins (a wrong rule must produce a red test) ———

describe('oracle honesty — negative pins', () => {
  const swapAt = (orig: string, opIndex: number, glyph: string): ReturnType<typeof canonOf> => {
    const carets = operatorCarets(rootOf(typeSource(orig)));
    const moved = applyOp(typeSource(orig), { op: 'moveCaret', to: carets[opIndex] });
    return canonOf(typeToken(moved, tokenOf(glyph)));
  };

  it('tie pin: a-b-c first −→+ is the typed a+b-c, never the CAS-style a-(b+c)', () => {
    const got = swapAt('a - b - c', 0, '+');
    expect(got).toEqual(canonMath(parse('a+b-c')));
    expect(got).not.toEqual(canonMath(parse('a-(b+c)')));
  });

  it('wrap pin: 5-2-1 first −→× is the typed 5*2-1, never 5-(2*1)', () => {
    const got = swapAt('5 - 2 - 1', 0, '*');
    expect(got).toEqual(canonMath(parse('5*2-1')));
    expect(got).not.toEqual(canonMath(parse('5-2*1')));
  });

  it('×↔÷ pin: 2*3*4 last ×→÷ is the typed 2*3/4, never a flattened divide', () => {
    const got = swapAt('2 * 3 * 4', 1, '/');
    expect(got).toEqual(canonMath(parse('2*3/4')));
    expect(got).not.toEqual(canonMath(parse('(2*3)/4*(1/1)')));
    void got;
  });
});
