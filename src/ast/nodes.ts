// AST node classes per the spec v1 node set. Nodes are dumb data:
// structure, serialization, and conversions only — no editing methods.

import type { NodeJson } from './json.js';
import type { MathNode as MathJsNode } from 'mathjs';
import {
  ConstantNode as MathConstantNode,
  FunctionNode as MathFunctionNode,
  OperatorNode as MathOperatorNode,
  ParenthesisNode as MathParenthesisNode,
  SymbolNode as MathSymbolNode,
} from 'mathjs';

export type NodeTag = 'num' | 'sym' | 'op' | 'fn' | 'group' | 'frac' | 'pow' | 'root' | 'sub' | 'unit';

/** mathjs function name → operator symbol (for mathjs OperatorNode construction). */
type MathJsOperatorFn = ConstructorParameters<typeof MathOperatorNode>[1];

export const OPERATOR_SYMBOLS: Readonly<Record<string, InstanceType<typeof MathOperatorNode>['op']>> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  unaryMinus: '-',
  unaryPlus: '+',
  pow: '^',
  mod: 'mod',
};

export const UNARY_OPS = new Set(['unaryMinus', 'unaryPlus']);

const incomplete = (what: string): Error => new Error(`toMathNode: incomplete tree (${what})`);

// ——— MathML Core rendering (visual-first: display, not evaluation) ———
//
// Every legal envelope renders; incomplete trees never throw — a null slot
// shows a visible placeholder, an empty-string field renders empty. Fences
// exist only where the tree has a GroupNode: precedence is structural, the
// renderer never re-derives it. Layout constructs (mspace) are injected here,
// never stored in the tree.

/** mathjs fn name → displayed operator symbol (Unicode minus/times, not ASCII). */
const OP_DISPLAY: Readonly<Record<string, string>> = {
  add: '+',
  subtract: '\u2212', // −
  multiply: '\u00D7', // ×
  divide: '/',
  unaryMinus: '\u2212', // −
  unaryPlus: '+',
  pow: '^',
  mod: 'mod',
};

/** Visible empty-slot glyph: U+25A1 WHITE SQUARE (rendering-side only, never stored). */
const EMPTY_SLOT = '<mi>□</mi>';

/** Thin space between a unit's value and its symbol (MathML Core mspace, ~0.167em). */
const UNIT_SPACE = '<mspace width="0.1667em"/>';

/** XML-escape text content — sym/fn names and unit strings are host-provided. */
const escapeMathml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * True when the fragment is exactly one balanced top-level element: the math
 * wrapper stays bare in that case and gains an mrow otherwise (a UnitNode
 * renders value + mspace + unit symbol — loose siblings at the top level).
 */
function isSingleMathmlElement(fragment: string): boolean {
  let depth = 0;
  let roots = 0;
  let i = 0;
  while (i < fragment.length) {
    if (fragment[i] !== '<') {
      if (depth === 0) return false; // stray top-level text
      i = fragment.indexOf('<', i);
      continue;
    }
    const close = fragment.indexOf('>', i);
    if (close === -1) return false;
    const tag = fragment.slice(i, close + 1);
    if (tag.startsWith('</')) {
      depth -= 1;
    } else if (!tag.endsWith('/>')) {
      if (depth === 0) roots += 1;
      depth += 1;
    } else if (depth === 0) {
      roots += 1;
    }
    i = close + 1;
  }
  return depth === 0 && roots === 1;
}

export abstract class MathNode {
  abstract readonly type: NodeTag;
  abstract toJSON(): NodeJson;
  abstract toMathNode(): MathJsNode;

  /** MathML Core markup for this node: `<math>…</math>`, fragment wrapped in an mrow. */
  toMathML(): string {
    const fragment = this.mathmlContent();
    return isSingleMathmlElement(fragment)
      ? `<math>${fragment}</math>`
      : `<math><mrow>${fragment}</mrow></math>`;
  }

  /** The node as a MathML fragment (possibly loose siblings, no outer element). */
  protected abstract mathmlContent(): string;

  /**
   * Loose flat-row form of this node — the token row without its own mrow — or
   * null when the node is not a flat operator row. Only a parent that hosts
   * the row as the sole content of its own row (GroupNode's fence row) uses
   * this: fences + the wrapped op's row are one mrow, never two.
   */
  protected flatRow(): string | null {
    return null;
  }

  /** Render a child slot: null = empty slot → visible placeholder. */
  protected childMathml(child: MathNode | null): string {
    return child === null ? EMPTY_SLOT : child.mathmlContent();
  }

  /**
   * Render a child into a fixed-arity slot (<mfrac>, <msup>, <msqrt>, <mroot>):
   * null = empty slot → visible placeholder. A multi-element fragment (a
   * UnitNode renders value + mspace + unit label as loose siblings) is wrapped
   * in a single mrow, so the slot always holds exactly one child element.
   */
  protected slotMathml(child: MathNode | null): string {
    if (child === null) return EMPTY_SLOT;
    const fragment = child.mathmlContent();
    return isSingleMathmlElement(fragment) ? fragment : `<mrow>${fragment}</mrow>`;
  }

  /**
   * Render the sole child this node's own row hosts (GroupNode's fence row):
   * a flat operator row inlines directly, everything else renders wrapped.
   */
  protected hostedChildMathml(child: MathNode | null): string {
    return child === null ? EMPTY_SLOT : (child.flatRow() ?? child.mathmlContent());
  }
}

const jsonOrNull = (node: MathNode | null): NodeJson | null => (node === null ? null : node.toJSON());

export class NumberNode extends MathNode {
  readonly type = 'num' as const;
  constructor(readonly value: number) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'num', value: this.value };
  }
  toMathNode(): MathJsNode {
    return new MathConstantNode(this.value);
  }
  protected mathmlContent(): string {
    return `<mn>${escapeMathml(String(this.value))}</mn>`;
  }
}

export class SymbolNode extends MathNode {
  readonly type = 'sym' as const;
  constructor(readonly name: string) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'sym', name: this.name };
  }
  toMathNode(): MathJsNode {
    return new MathSymbolNode(this.name);
  }
  protected mathmlContent(): string {
    return `<mi>${escapeMathml(this.name)}</mi>`;
  }
}

/** n-ary operator; `op` is a mathjs function name (add, subtract, multiply, unaryMinus, ...). */
export class OperatorNode extends MathNode {
  readonly type = 'op' as const;
  constructor(readonly op: string, readonly args: (MathNode | null)[]) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'op', op: this.op, args: this.args.map(jsonOrNull) };
  }
  toMathNode(): MathJsNode {
    const symbol = OPERATOR_SYMBOLS[this.op];
    if (symbol === undefined) {
      throw new Error(`toMathNode: unknown operator '${this.op}'`);
    }
    const args = this.args.map((arg) => {
      if (arg === null) throw incomplete(`op '${this.op}' has an empty slot`);
      return arg.toMathNode();
    });
    if (UNARY_OPS.has(this.op)) {
      if (args.length !== 1) throw incomplete(`unary op '${this.op}' takes exactly one arg, got ${args.length}`);
      return new MathOperatorNode(symbol, this.op as MathJsOperatorFn, args);
    }
    if (args.length < 2) throw incomplete(`op '${this.op}' needs at least two args, got ${args.length}`);
    // Fold the n-ary chain left-associatively into binary OperatorNodes.
    return args.reduce((left, right) => new MathOperatorNode(symbol, this.op as MathJsOperatorFn, [left, right]));
  }
  protected mathmlContent(): string {
    if (UNARY_OPS.has(this.op)) {
      if (this.args.length === 0) {
        return `<mrow><mo>${this.opDisplay()}</mo>${EMPTY_SLOT}</mrow>`;
      }
      return `<mrow><mo>${this.opDisplay()}</mo>${this.args.map((a) => this.childMathml(a)).join('')}</mrow>`;
    }
    // A ≤2-arg pow op is stored-legal and must display like PowerNode (msup);
    // longer chains are TS-only shapes (fromJSON rejects >2) and fall back to
    // a flat row so the renderer never throws.
    if (this.op === 'pow' && this.args.length <= 2) {
      return `<msup>${this.slotMathml(this.args[0] ?? null)}${this.slotMathml(this.args[1] ?? null)}</msup>`;
    }
    return `<mrow>${this.rowTokens()}</mrow>`;
  }
  protected flatRow(): string | null {
    return UNARY_OPS.has(this.op) || (this.op === 'pow' && this.args.length <= 2)
      ? null
      : this.rowTokens();
  }
  /** Flat token row: args (never zero — an empty op shows one slot) joined by separator mo's. */
  private rowTokens(): string {
    const args = this.args.length === 0 ? [null] : this.args;
    return args.map((a) => this.childMathml(a)).join(`<mo>${this.opDisplay()}</mo>`);
  }
  /** Displayed glyph; unknown op names (host-built junk) render as their name. */
  private opDisplay(): string {
    return OP_DISPLAY[this.op] ?? escapeMathml(this.op);
  }
}

/** n-ary function call. */
export class FunctionNode extends MathNode {
  readonly type = 'fn' as const;
  constructor(readonly name: string, readonly args: (MathNode | null)[]) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'fn', name: this.name, args: this.args.map(jsonOrNull) };
  }
  toMathNode(): MathJsNode {
    if (this.name === '') throw incomplete('function name is empty');
    const args = this.args.map((arg) => {
      if (arg === null) throw incomplete(`fn '${this.name}' has an empty slot`);
      return arg.toMathNode();
    });
    return new MathFunctionNode(this.name, args);
  }
  protected mathmlContent(): string {
    // Name + fenced args; commas separate multiple args, a zero-arg call
    // (complete, evaluable — host zero-arg functions are legal) shows ().
    const args = this.args.map((a) => this.childMathml(a)).join('<mo>,</mo>');
    return `<mrow><mi>${escapeMathml(this.name)}</mi><mo fence="true">(</mo>${args}<mo fence="true">)</mo></mrow>`;
  }
}

/** Order-of-operations marker with exactly one child; the only v1 parens value is 'always'. */
export type GroupParens = 'always';

export class GroupNode extends MathNode {
  readonly type = 'group' as const;
  readonly parens: GroupParens = 'always';
  constructor(readonly child: MathNode | null) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'group', parens: this.parens, child: jsonOrNull(this.child) };
  }
  toMathNode(): MathJsNode {
    if (this.child === null) throw incomplete('group child is empty');
    return new MathParenthesisNode(this.child.toMathNode());
  }
  protected mathmlContent(): string {
    // parens: 'always' — user-expressed parens, the only fence source. A bare
    // flat operator row as the child is the fence row's own content: one mrow.
    return `<mrow><mo fence="true">(</mo>${this.hostedChildMathml(this.child)}<mo fence="true">)</mo></mrow>`;
  }
}

export class FractionNode extends MathNode {
  readonly type = 'frac' as const;
  constructor(readonly num: MathNode | null, readonly den: MathNode | null) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'frac', num: jsonOrNull(this.num), den: jsonOrNull(this.den) };
  }
  toMathNode(): MathJsNode {
    if (this.num === null || this.den === null) throw incomplete('fraction slot is empty');
    return new MathOperatorNode('/', 'divide', [this.num.toMathNode(), this.den.toMathNode()]);
  }
  protected mathmlContent(): string {
    return `<mfrac>${this.slotMathml(this.num)}${this.slotMathml(this.den)}</mfrac>`;
  }
}

export class PowerNode extends MathNode {
  readonly type = 'pow' as const;
  constructor(readonly base: MathNode | null, readonly exp: MathNode | null) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'pow', base: jsonOrNull(this.base), exp: jsonOrNull(this.exp) };
  }
  toMathNode(): MathJsNode {
    if (this.base === null || this.exp === null) throw incomplete('power slot is empty');
    return new MathOperatorNode('^', 'pow', [this.base.toMathNode(), this.exp.toMathNode()]);
  }
  protected mathmlContent(): string {
    return `<msup>${this.slotMathml(this.base)}${this.slotMathml(this.exp)}</msup>`;
  }
}

/** index null (default) means square root. */
export class RootNode extends MathNode {
  readonly type = 'root' as const;
  constructor(readonly radicand: MathNode | null, readonly index: MathNode | null = null) {
    super();
  }
  toJSON(): NodeJson {
    // Spec: index is omitted when null (square root).
    const json: NodeJson = { type: 'root', radicand: jsonOrNull(this.radicand) };
    return this.index === null ? json : { ...json, index: this.index.toJSON() };
  }
  toMathNode(): MathJsNode {
    if (this.radicand === null) throw incomplete('root radicand is empty');
    if (this.index === null) {
      return new MathFunctionNode('sqrt', [this.radicand.toMathNode()]);
    }
    return new MathFunctionNode('nthRoot', [this.radicand.toMathNode(), this.index.toMathNode()]);
  }
  protected mathmlContent(): string {
    // index null (or omitted) = square root: msqrt; otherwise mroot.
    if (this.index === null) {
      return `<msqrt>${this.slotMathml(this.radicand)}</msqrt>`;
    }
    return `<mroot>${this.slotMathml(this.radicand)}${this.slotMathml(this.index)}</mroot>`;
  }
}

/** Label mode only in v1: base and sub are plain strings; projects to a flat SymbolNode (e.g. x_max). */
export class SubscriptNode extends MathNode {
  readonly type = 'sub' as const;
  constructor(readonly base: string, readonly sub: string) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'sub', base: this.base, sub: this.sub };
  }
  toMathNode(): MathJsNode {
    if (this.base === '' || this.sub === '') throw incomplete('subscript label is empty');
    // Flat SymbolNode — name identity: two symbols are the same name iff these are equal.
    return new MathSymbolNode(`${this.base}_${this.sub}`);
  }
  protected mathmlContent(): string {
    // Label mode: both parts are strings. Empty is the incomplete state and
    // renders empty, not as a slot placeholder — only null slots are □.
    return `<msub><mi>${escapeMathml(this.base)}</mi><mi>${escapeMathml(this.sub)}</mi></msub>`;
  }
}

/** `unit` is a mathjs unit syntax string (e.g. 'mm'). */
export class UnitNode extends MathNode {
  readonly type = 'unit' as const;
  constructor(readonly value: MathNode | null, readonly unit: string) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'unit', value: jsonOrNull(this.value), unit: this.unit };
  }
  toMathNode(): MathJsNode {
    if (this.value === null) throw incomplete('unit value is empty');
    if (this.unit === '') throw incomplete('unit name is empty');
    // Spike-verified unit-bearing construct: implicit multiply with a unit symbol
    // evaluates to a mathjs Unit (identical to what math.parse produces for '50 mm').
    return new MathOperatorNode('*', 'multiply', [this.value.toMathNode(), new MathSymbolNode(this.unit)], true);
  }
  protected mathmlContent(): string {
    // Engineering convention: the unit symbol is upright, separated from the
    // value by a thin mspace (implicit multiply, no × glyph). An empty unit
    // string is the incomplete state — empty upright mi, and no separator
    // (nothing to separate).
    if (this.unit === '') {
      return `${this.childMathml(this.value)}<mi mathvariant="normal"></mi>`;
    }
    return `${this.childMathml(this.value)}${UNIT_SPACE}<mi mathvariant="normal">${escapeMathml(this.unit)}</mi>`;
  }
}
