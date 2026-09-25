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

export abstract class MathNode {
  abstract readonly type: NodeTag;
  abstract toJSON(): NodeJson;
  abstract toMathNode(): MathJsNode;

  // TODO: MathML Core rendering — deferred with the editor layer (spec phasing).
  toMathML(): never {
    throw new Error('toMathML: not implemented');
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
}
