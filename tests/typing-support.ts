// Typing-oracle support (test-side only; never shipped): a fixed-purpose
// lexer that turns corpus source strings into typed tokens, the oracle
// corpus, and the canonicalizer that folds mathjs's left-nested same-op
// trees into our flat chain form on BOTH sides — integration compares
// canonical shapes. Integral never parses text; this harness exists so the
// policy's typed insertion can be checked against math.parse end to end.

import { parse } from 'mathjs';
import type {
  ConstantNode as MathConstantNode,
  MathNode as MathJsNode,
  OperatorNode as MathOperatorNode,
  ParenthesisNode as MathParenthesisNode,
  SymbolNode as MathSymbolNode,
} from 'mathjs';
import type { NodeJson } from '../src/ast/index.js';
import { envelopeOf, initSession, typeToken, type EditingState, type TypedToken } from '../src/engine/index.js';

// ——— Lexer (corpus grammar: integers, single-letter symbols, + - * / ^
// mod ( ) — only what the policy owns; no functions/units) ———

export function lex(source: string): TypedToken[] {
  const tokens: TypedToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ') {
      i += 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < source.length && source[j] >= '0' && source[j] <= '9') j += 1;
      tokens.push({ t: 'leaf', node: { type: 'num', value: Number(source.slice(i, j)) } });
      i = j;
      continue;
    }
    if (ch >= 'a' && ch <= 'z') {
      if (source.startsWith('mod', i) && !/[a-z]/.test(source[i + 3] ?? '')) {
        tokens.push({ t: 'operator', fn: 'mod' });
        i += 3;
        continue;
      }
      tokens.push({ t: 'leaf', node: { type: 'sym', name: ch } });
      i += 1;
      continue;
    }
    const single: Record<string, TypedToken> = {
      '+': { t: 'operator', fn: 'add' },
      '-': { t: 'operator', fn: 'subtract' },
      '*': { t: 'operator', fn: 'multiply' },
      '/': { t: 'divide' },
      '^': { t: 'pow' },
      '(': { t: 'groupOpen' },
      ')': { t: 'groupClose' },
    };
    if (single[ch] === undefined) throw new Error(`lexer: unexpected character '${ch}'`);
    tokens.push(single[ch]);
    i += 1;
  }
  return tokens;
}

/** The per-token source prefixes (source through the end of the i-th
 *  token), so prefix checks slice the real source — spacing preserved. */
export function lexPrefixes(source: string): string[] {
  const prefixes: string[] = [];
  for (const m of source.matchAll(/\d+|[a-z]+|[()+\-*/^]|\s+/g)) {
    if (/^\s+$/.test(m[0])) continue;
    prefixes.push(source.slice(0, (m.index ?? 0) + m[0].length));
  }
  return prefixes;
}

// ——— Corpus ———
// Linear typing sequences an editor user actually produces. Juxtaposition
// ('a(b)') is deliberately absent: mathjs parses it as implicit
// multiplication, which no plain op row here represents.

export const CORPUS: readonly string[] = [
  '1+2',
  '12+34',
  'a+b+c',
  'a-b+c',
  'a+b-c',
  'a-b-c',
  'a*b*c',
  'a+b*c',
  'a*b+c',
  'a/b',
  'a/b/c',
  'a/b*c',
  'a*b/c',
  'a+b/c',
  'a mod b',
  'a mod b mod c',
  'a*2 mod 3',
  '2 mod 3*4',
  '2^3',
  '2^3^4',
  '2^3*4',
  '2*3^4',
  '2+3*4^2',
  '-2',
  '-2^2',
  '-2*3',
  '2*-3',
  '2--3',
  '2++3',
  '2^-3',
  'a+-b',
  'a/-b',
  'a*-b*c',
  '(a+b)',
  '(a+b)*c',
  'a*(b+c)',
  'a+(b*c)',
  '(a-b)*(c+d)',
  '((a-b))',
  '(2)^3',
  '-(a+b)',
  'a/(b*c)',
  '2*(3+4)-(5-1)',
  '2+3*(4-5)/6',
  '(1+2)*(3+4)^(5-6)',
  '5+4*3/2-1',
];

/** Type a full corpus source through the policy into a final state. */
export function typeSource(source: string): EditingState {
  let state = initSession();
  for (const token of lex(source)) state = typeToken(state, token);
  return state;
}

// ——— Canonicalizer ———
//
// Both sides fold to the same shape: our flat same-op chains stay flat,
// mathjs's left-nested same-op OperatorNodes fold into that same flat chain
// form; divide and pow NEVER fold (÷ never flattens; pow keeps its nesting
// — it is right-associative and our PowerNode/FractionNode are binary
// structs); GroupNode maps to mathjs's ParenthesisNode. The normalizer
// strengthens the oracle, never weakens it: any mismatch is a red test.

export type Canon =
  | { k: 'num'; v: number }
  | { k: 'sym'; n: string }
  | { k: 'chain'; op: string; args: Canon[] }
  | { k: 'op'; op: 'divide' | 'pow'; args: Canon[] }
  | { k: 'group'; child: Canon }
  | { k: 'raw'; s: string };

export function canonAst(json: NodeJson | null): Canon {
  if (json === null) return { k: 'raw', s: '<empty slot>' };
  switch (json.type) {
    case 'num':
      return { k: 'num', v: json.value };
    case 'sym':
      return { k: 'sym', n: json.name };
    case 'sub':
      return { k: 'sym', n: `${json.base}_${json.sub}` };
    case 'op':
      return json.op === 'pow' && json.args.length === 2
        ? { k: 'op', op: 'pow', args: json.args.map(canonAst) }
        : { k: 'chain', op: json.op, args: json.args.map(canonAst) };
    case 'frac':
      return { k: 'op', op: 'divide', args: [canonAst(json.num), canonAst(json.den)] };
    case 'pow':
      return { k: 'op', op: 'pow', args: [canonAst(json.base), canonAst(json.exp)] };
    case 'group':
      return { k: 'group', child: canonAst(json.child) };
    default:
      return { k: 'raw', s: JSON.stringify(json) };
  }
}

const CHAIN_FNS = new Set(['add', 'subtract', 'multiply', 'mod', 'unaryMinus', 'unaryPlus']);

/** Fold mathjs's left-nested same-op chains into our flat chain form. */
function chainArgs(fn: string, node: MathOperatorNode): Canon[] {
  const [left, right] = node.args;
  const leftFn = left.type === 'OperatorNode' ? (left as MathOperatorNode) : null;
  if (leftFn !== null && leftFn.fn === fn && leftFn.args.length === 2) {
    return [...chainArgs(fn, leftFn), canonMath(right)];
  }
  return [canonMath(left), canonMath(right)];
}

export function canonMath(node: MathJsNode): Canon {
  switch (node.type) {
    case 'ConstantNode':
      return { k: 'num', v: (node as MathConstantNode).value as number };
    case 'SymbolNode':
      return { k: 'sym', n: (node as MathSymbolNode).name };
    case 'ParenthesisNode':
      return { k: 'group', child: canonMath((node as MathParenthesisNode).content) };
    case 'OperatorNode': {
      const op = node as MathOperatorNode;
      if (op.fn === 'pow' || op.fn === 'divide') {
        return { k: 'op', op: op.fn, args: op.args.map(canonMath) };
      }
      if (CHAIN_FNS.has(op.fn)) {
        return { k: 'chain', op: op.fn, args: op.args.length === 1 ? [canonMath(op.args[0])] : chainArgs(op.fn, op) };
      }
      return { k: 'raw', s: node.toString() };
    }
    default:
      return { k: 'raw', s: node.toString() };
  }
}

// ——— Prefix comparison ———

/** True iff the envelope contains any empty slot / null args cell. */
export function hasEmptySlot(json: NodeJson | null): boolean {
  if (json === null) return true;
  if (json.type === 'op' || json.type === 'fn') {
    return json.args.some((arg) => hasEmptySlot(arg));
  }
  const slots: (NodeJson | null)[] =
    json.type === 'group'
      ? [json.child]
      : json.type === 'frac'
        ? [json.num, json.den]
        : json.type === 'pow'
          ? [json.base, json.exp]
          : json.type === 'root'
            ? [json.radicand]
            : [];
  return slots.some((slot) => hasEmptySlot(slot));
}

/** For every prefix of the token stream that parses as a complete mathjs
 *  expression, the policy's tree so far must be that expression. Returns
 *  the number of prefixes compared (at least the full source always is). */
export function compareAgainstParse(source: string): number {
  const tokens = lex(source);
  const prefixes = lexPrefixes(source);
  let state = initSession();
  let compared = 0;
  tokens.forEach((token, i) => {
    state = typeToken(state, token);
    const prefix = prefixes[i];
    let tree: MathJsNode;
    try {
      tree = parse(prefix);
    } catch {
      return; // incomplete prefix — nothing to compare against
    }
    const env = envelopeOf(state);
    if (hasEmptySlot(env.root)) {
      throw new Error(`prefix "${prefix}" parses but the typed tree is incomplete`);
    }
    if (JSON.stringify(canonAst(env.root)) !== JSON.stringify(canonMath(tree))) {
      throw new Error(
        `oracle mismatch at prefix "${prefix}":\n  typed: ${JSON.stringify(canonAst(env.root))}\n  parse: ${JSON.stringify(canonMath(tree))}`,
      );
    }
    compared += 1;
  });
  return compared;
}
