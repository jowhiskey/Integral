// AST node classes per the spec v1 node set. Nodes are dumb data:
// structure, serialization, and conversions only — no editing methods.

import type { FencePath, NodeJson } from './json.js';
import type { MathNode as MathJsNode } from 'mathjs';
import {
  ConstantNode as MathConstantNode,
  FunctionNode as MathFunctionNode,
  OperatorNode as MathOperatorNode,
  ParenthesisNode as MathParenthesisNode,
  SymbolNode as MathSymbolNode,
} from 'mathjs';

export type NodeTag = 'num' | 'sym' | 'op' | 'fn' | 'group' | 'frac' | 'pow' | 'root' | 'sub' | 'unit' | 'fence';

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

/**
 * S-098 seam marker: the subtle styling hook rendered between two adjacent
 * NUMBER cells of an implicit-multiply row (the forbidden number-number
 * adjacency). The element itself is an inert spacer; host CSS paints the
 * quiet background highlight. Styling-level only.
 */
const SEAM_MARKER = '<mspace class="integral-seam" width="0.1667em"/>';

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

  /** Render a row cell: null renders BARE (T7 split — a row-level missing
   *  operand shows no placeholder; the neighboring glyphs carry the state). */
  protected bareMathml(child: MathNode | null): string {
    return child === null ? '' : child.mathmlContent();
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

/**
 * True when the cells form the math-style unary-projection pattern (Owner
 * amendment, empty-slot operator rows): a null cell means the glyph FOLLOWING
 * it applies unary to the cell after it — leading `−` negates, leading `+` is
 * identity, a doubled operator acts on what follows (one null cell between
 * two glyphs). Trailing null, two consecutive nulls, and rows with fewer
 * than two cells do not project.
 */
export function projectsUnaryRow(args: readonly (MathNode | null)[]): boolean {
  if (args.length < 2) return false;
  if (args[args.length - 1] === null) return false;
  for (let i = 0; i + 1 < args.length; i += 1) {
    if (args[i] === null && args[i + 1] === null) return false;
  }
  return true;
}

/**
 * Glyph-less juxtaposition adjacency (Owner amendment): a pair is legal iff
 * its left cell is a number and its right cell is not — a number before a
 * symbol/group/structure is implicit multiplication; a symbol (or any other
 * non-number) before anything refuses (evaluation annotation, not a typing
 * restriction); number next to number stays forbidden (S-098).
 */
export function implicitPairLegal(left: MathNode, right: MathNode): boolean {
  return left.type === 'num' && right.type !== 'num';
}

/** n-ary operator; `op` is a mathjs function name (add, subtract, multiply, unaryMinus, ...).
 * `implicit` marks glyph-less juxtaposition: the row stores as multiply, renders
 * without × glyphs, and folds as implicit multiplication. The marker is
 * rendering/storability only — never evaluation semantics. */
export class OperatorNode extends MathNode {
  readonly type = 'op' as const;
  constructor(
    readonly op: string,
    readonly args: (MathNode | null)[],
    readonly implicit: boolean = false,
  ) {
    super();
  }
  toJSON(): NodeJson {
    return this.implicit
      ? { type: 'op', op: this.op, args: this.args.map(jsonOrNull), implicit: true }
      : { type: 'op', op: this.op, args: this.args.map(jsonOrNull) };
  }
  toMathNode(): MathJsNode {
    const symbol = OPERATOR_SYMBOLS[this.op];
    if (symbol === undefined) {
      throw new Error(`toMathNode: unknown operator '${this.op}'`);
    }
    if (UNARY_OPS.has(this.op)) {
      const cells = this.args.map((arg) => {
        if (arg === null) throw incomplete(`op '${this.op}' has an empty slot`);
        return arg.toMathNode();
      });
      if (cells.length !== 1) throw incomplete(`unary op '${this.op}' takes exactly one arg, got ${cells.length}`);
      return new MathOperatorNode(symbol, this.op as MathJsOperatorFn, cells);
    }
    if (this.implicit) {
      // Glyph-less adjacency folds as plain implicit multiplication (like
      // mathjs's own parse of `5x`). The juxtaposition REFUSALS live in
      // isEvaluable (the gate), and the projection throws on them so a host
      // skipping the gate cannot evaluate a refused state.
      if (this.op !== 'multiply') throw incomplete(`op '${this.op}' cannot carry the implicit marker`);
      const cells = this.args.map((arg) => {
        if (arg === null) throw incomplete(`implicit multiply row has an empty slot`);
        return arg;
      });
      for (let i = 1; i < cells.length; i += 1) {
        if (!implicitPairLegal(cells[i - 1], cells[i])) {
          throw incomplete(`implicit adjacency (${cells[i - 1].type} next to ${cells[i].type}) refuses evaluation`);
        }
      }
      return cells
        .map((cell) => cell.toMathNode())
        .reduce((left, right) => new MathOperatorNode(symbol, 'multiply' as MathJsOperatorFn, [left, right], true));
    }
    if ((this.op === 'add' || this.op === 'subtract') && this.args.some((a) => a === null)) {
      // Math-style projection of empty-slot operator rows: a null cell means
      // the following glyph applies unary to the cell after it. Non-projecting
      // shapes (trailing null, consecutive nulls) throw — the editor never
      // stores unary nodes; the projection alone creates them.
      if (!projectsUnaryRow(this.args)) {
        throw incomplete(`op '${this.op}' row with empty cells does not project (trailing or consecutive empty cell)`);
      }
      const unaryFn = (this.op === 'subtract' ? 'unaryMinus' : 'unaryPlus') as MathJsOperatorFn;
      let acc: MathJsNode | null = null;
      let pendingUnary = false;
      for (const cell of this.args) {
        if (cell === null) {
          pendingUnary = true;
          continue;
        }
        let term = cell.toMathNode();
        if (pendingUnary) term = new MathOperatorNode(symbol, unaryFn, [term]);
        acc = acc === null ? term : new MathOperatorNode(symbol, this.op as MathJsOperatorFn, [acc, term]);
        pendingUnary = false;
      }
      return acc as MathJsNode; // non-null: >=2 cells, no trailing/consecutive nulls
    }
    const args = this.args.map((arg) => {
      if (arg === null) throw incomplete(`op '${this.op}' has an empty slot`);
      return arg.toMathNode();
    });
    if (args.length < 2) throw incomplete(`op '${this.op}' needs at least two args, got ${args.length}`);
    // Fold the n-ary chain left-associatively into binary OperatorNodes.
    return args.reduce((left, right) => new MathOperatorNode(symbol, this.op as MathJsOperatorFn, [left, right]));
  }
  protected mathmlContent(): string {
    if (UNARY_OPS.has(this.op)) {
      // The unary glyph leads; a null cell renders BARE (T7 split: row-level
      // missing operands show no placeholder).
      return `<mrow><mo>${this.opDisplay()}</mo>${this.args.map((a) => this.bareMathml(a)).join('')}</mrow>`;
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
  /**
   * Flat token row (the T7 split): a null cell renders BARE — the neighboring
   * separator glyphs carry the visual state (leading `+`, trailing `−x+`,
   * interior doubles like `a+b++c` all fall out of the join; an operand-less
   * row renders nothing). Implicit (glyph-less) multiply rows render NO
   * separator glyphs; the forbidden number-number adjacency (S-098) renders
   * the seam marker between the two nodes.
   */
  private rowTokens(): string {
    const sep = this.implicit ? '' : `<mo>${this.opDisplay()}</mo>`;
    let out = '';
    this.args.forEach((arg, i) => {
      const prev = i > 0 ? this.args[i - 1] : null;
      if (this.implicit && prev !== null && arg !== null && prev.type === 'num' && arg.type === 'num') {
        out += SEAM_MARKER;
      }
      if (i > 0) out += sep;
      out += this.bareMathml(arg);
    });
    return out;
  }
  /** Displayed glyph; unknown op names (host-built junk) render as their name. */
  private opDisplay(): string {
    return OP_DISPLAY[this.op] ?? escapeMathml(this.op);
  }
}

/** n-ary function call. `close = false` = the movable closing fence is absent
 * (unbalanced state: storable + renders; refused by the structural gate). */
export class FunctionNode extends MathNode {
  readonly type = 'fn' as const;
  constructor(
    readonly name: string,
    readonly args: (MathNode | null)[],
    readonly close: boolean = true,
  ) {
    super();
  }
  toJSON(): NodeJson {
    return this.close
      ? { type: 'fn', name: this.name, args: this.args.map(jsonOrNull) }
      : { type: 'fn', name: this.name, args: this.args.map(jsonOrNull), close: false };
  }
  toMathNode(): MathJsNode {
    if (this.close === false) throw incomplete('function is missing its closing fence');
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
    // Function arguments are placeholder territory (T7/S-023): a null arg
    // cell renders exactly one □. close = false: the movable closing fence
    // is absent — the row stands open.
    const args = this.args.map((a) => this.childMathml(a)).join('<mo>,</mo>');
    const close = this.close ? '<mo fence="true">)</mo>' : '';
    return `<mrow><mi>${escapeMathml(this.name)}</mi><mo fence="true">(</mo>${args}${close}</mrow>`;
  }
}

/** Order-of-operations marker with exactly one child; the only v1 parens value is 'always'.
 * `close = false` = the movable closing fence is absent (unbalanced state:
 * storable + renders; refused by the structural gate). */
export type GroupParens = 'always';

export class GroupNode extends MathNode {
  readonly type = 'group' as const;
  readonly parens: GroupParens = 'always';
  constructor(
    readonly child: MathNode | null,
    readonly close: boolean = true,
  ) {
    super();
  }
  toJSON(): NodeJson {
    return this.close
      ? { type: 'group', parens: this.parens, child: jsonOrNull(this.child) }
      : { type: 'group', parens: this.parens, child: jsonOrNull(this.child), close: false };
  }
  toMathNode(): MathJsNode {
    if (this.close === false) throw incomplete('group is missing its closing fence');
    if (this.child === null) throw incomplete('group child is empty');
    return new MathParenthesisNode(this.child.toMathNode());
  }
  protected mathmlContent(): string {
    // parens: 'always' — user-expressed parens, the only fence source; the
    // open fence always renders. A bare flat operator row as the child is the
    // fence row's own content: one mrow. Emptied content shows the standing
    // □ affordance (S-079). close = false: the row stands open.
    const close = this.close ? '<mo fence="true">)</mo>' : '';
    return `<mrow><mo fence="true">(</mo>${this.hostedChildMathml(this.child)}${close}</mrow>`;
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

/** index null (default) means square root. `mroot = true` marks an nth root
 * whose index slot exists — index null then renders mroot with a □ index slot
 * (an empty 2D-slot state) instead of collapsing to the square-root form. */
export class RootNode extends MathNode {
  readonly type = 'root' as const;
  constructor(
    readonly radicand: MathNode | null,
    readonly index: MathNode | null = null,
    readonly mroot: boolean = false,
  ) {
    super();
  }
  toJSON(): NodeJson {
    // Spec: index is omitted when null (square root).
    const json: NodeJson = { type: 'root', radicand: jsonOrNull(this.radicand) };
    const withIndex = this.index === null ? json : { ...json, index: this.index.toJSON() };
    return this.mroot ? { ...withIndex, mroot: true } : withIndex;
  }
  toMathNode(): MathJsNode {
    if (this.mroot && this.index === null) throw incomplete('root index slot is empty');
    if (this.radicand === null) throw incomplete('root radicand is empty');
    if (this.index === null) {
      return new MathFunctionNode('sqrt', [this.radicand.toMathNode()]);
    }
    return new MathFunctionNode('nthRoot', [this.radicand.toMathNode(), this.index.toMathNode()]);
  }
  protected mathmlContent(): string {
    // index null without mroot = square root: msqrt; an mroot with an empty
    // index slot keeps the structure — the □ index is the T7 standing affordance.
    if (this.index === null && !this.mroot) {
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

// ——— Movable close-fence tokens (session 1, additive) ———

/**
 * A close-fence glyph token (the movable-paren model, C4/S-097): the ')' the
 * user can delete, re-type, and insert elsewhere. `open` = the path to the
 * open fence this token belongs to (a group/fn carrying `close: false`);
 * null (and the omitted `open` field) = a DANGLING close — nothing unclosed
 * to its left. A fence glyph is never a value: it stores and renders, and the
 * existing structural gate refuses every state that contains one.
 */
export class FenceNode extends MathNode {
  readonly type = 'fence' as const;
  readonly side = 'close' as const;
  constructor(readonly open: FencePath | null = null) {
    super();
  }
  toJSON(): NodeJson {
    return this.open === null
      ? { type: 'fence', side: 'close' }
      : { type: 'fence', side: 'close', open: this.open };
  }
  toMathNode(): MathJsNode {
    throw incomplete('close fence glyph is not a value');
  }
  protected mathmlContent(): string {
    return '<mo fence="true">)</mo>';
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
