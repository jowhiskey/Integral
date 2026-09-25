// AST node classes per the spec v1 node set. Nodes are dumb data:
// structure, serialization, and conversions only — no editing methods.

import type { NodeJson } from './json.js';

export type NodeTag = 'num' | 'sym' | 'op' | 'fn' | 'group' | 'frac' | 'pow' | 'root' | 'sub' | 'unit';

export abstract class MathNode {
  abstract readonly type: NodeTag;
  abstract toJSON(): NodeJson;
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
}

export class SymbolNode extends MathNode {
  readonly type = 'sym' as const;
  constructor(readonly name: string) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'sym', name: this.name };
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
}

export class FractionNode extends MathNode {
  readonly type = 'frac' as const;
  constructor(readonly num: MathNode | null, readonly den: MathNode | null) {
    super();
  }
  toJSON(): NodeJson {
    return { type: 'frac', num: jsonOrNull(this.num), den: jsonOrNull(this.den) };
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
}
