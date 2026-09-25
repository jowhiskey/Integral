// AST node classes per the spec v1 node set. Nodes are dumb data:
// structure, serialization, and conversions only — no editing methods.

export type NodeTag = 'num' | 'sym' | 'op' | 'fn' | 'group' | 'frac' | 'pow' | 'root' | 'sub' | 'unit';

export abstract class MathNode {
  abstract readonly type: NodeTag;
}

export class NumberNode extends MathNode {
  readonly type = 'num' as const;
  constructor(readonly value: number) {
    super();
  }
}

export class SymbolNode extends MathNode {
  readonly type = 'sym' as const;
  constructor(readonly name: string) {
    super();
  }
}

/** n-ary operator; `op` is a mathjs function name (add, subtract, multiply, unaryMinus, ...). */
export class OperatorNode extends MathNode {
  readonly type = 'op' as const;
  constructor(readonly op: string, readonly args: (MathNode | null)[]) {
    super();
  }
}

/** n-ary function call. */
export class FunctionNode extends MathNode {
  readonly type = 'fn' as const;
  constructor(readonly name: string, readonly args: (MathNode | null)[]) {
    super();
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
}

export class FractionNode extends MathNode {
  readonly type = 'frac' as const;
  constructor(readonly num: MathNode | null, readonly den: MathNode | null) {
    super();
  }
}

export class PowerNode extends MathNode {
  readonly type = 'pow' as const;
  constructor(readonly base: MathNode | null, readonly exp: MathNode | null) {
    super();
  }
}

/** index null (default) means square root. */
export class RootNode extends MathNode {
  readonly type = 'root' as const;
  constructor(readonly radicand: MathNode | null, readonly index: MathNode | null = null) {
    super();
  }
}

/** Label mode only in v1: base and sub are plain strings; projects to a flat SymbolNode (e.g. x_max). */
export class SubscriptNode extends MathNode {
  readonly type = 'sub' as const;
  constructor(readonly base: string, readonly sub: string) {
    super();
  }
}

/** `unit` is a mathjs unit syntax string (e.g. 'mm'). */
export class UnitNode extends MathNode {
  readonly type = 'unit' as const;
  constructor(readonly value: MathNode | null, readonly unit: string) {
    super();
  }
}
