// Envelope-level serialization: toJSON(root) wraps a node in { v: 1, root };
// fromJSON validates the structural invariants and rejects invalid trees.
// Missing/omitted empty slots are accepted on read; toJSON always emits null
// (except root index, which the spec omits when null).
//
// fromJSON is the validation boundary for untrusted JSON: every rejection is
// a typed ValidationError (ValidationLimitError for budget overruns), the
// walk is preceded by an iterative budget pre-pass so no envelope can crash
// the process with a stack overflow, and the emitted tree is guaranteed to
// stay inside budgets its own evaluation engine can handle.

import type { Envelope, NodeJson } from './json.js';
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
  UNARY_OPS,
  UnitNode,
} from './nodes.js';
import { defaultStaticVocabulary, isParserShadowed, isUnitSymbolShape, type StaticVocabulary } from './vocabulary.js';
import { AST_LIMITS, ValidationError, ValidationLimitError } from './validation.js';

export function toJSON(root: MathNode | null): Envelope {
  return { v: 1, root: root === null ? null : root.toJSON() };
}

/**
 * Deserialize a formula envelope.
 *
 * Non-empty UnitNode.unit strings must be members of the vocabulary's unit
 * set — shape-only validation let arbitrary identifiers pass as units. Empty
 * strings stay legal (incomplete-tree rule: empty `unit.unit` is a legal
 * in-progress state, like an empty fraction slot).
 *
 * Vocabulary parameter semantics: omitted → default static vocabulary (the
 * prefix-aware derived list). When a vocabulary IS passed, its `units` list
 * fully replaces the default gate, and omitting `units` means the host
 * declares no units (never a silent fallback to the 2770-entry default).
 * Custom entries are format-guarded: each must be identifier-shaped (the
 * frozen SymbolNode projection cannot carry anything else) and must not be
 * a name the expression parser resolves as a function or constant first.
 * Strings mathjs does not know are accepted on the host's authority — the
 * host is responsible for defining them (e.g. via createUnit) in the mathjs
 * instance it evaluates with.
 *
 * Structural budgets (AST_LIMITS): depth and node count are enforced with
 * typed ValidationLimitError, so an oversized envelope is a validation
 * error, never an uncontrolled stack-overflow crash, and the layer never
 * emits a tree its own evaluation engine cannot evaluate (an n-ary chain
 * folds to a binary chain as deep as its arg count).
 *
 * Non-finite `num` values (NaN, ±Infinity) reject: JSON.stringify collapses
 * them to null, so such an envelope cannot survive one persistence cycle.
 * `-0` is normalized to `0` — the JSON contract cannot carry the sign, so a
 * numerically valid value is normalized instead of rejected.
 *
 * Subscript labels (`sub.base`, `sub.sub`) must be identifier-shaped and
 * `_`-free when non-empty: the projection `base + '_' + sub` is injective
 * (and display-stable) only under that rule. Empty stays legal (incomplete
 * tree).
 */
export function fromJSON(envelope: unknown, vocabulary?: StaticVocabulary): MathNode | null {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new ValidationError('fromJSON: envelope must be an object');
  }
  const { v, root } = envelope as { v?: unknown; root?: unknown };
  if (v !== 1) {
    throw new ValidationError(
      `fromJSON: unsupported envelope version ${JSON.stringify(v) ?? 'undefined'} (expected 1)`,
    );
  }
  if (root === null || root === undefined) {
    return null; // empty formula: empty-slot rule extended to the root
  }
  const allowedUnits = allowedUnitsFor(vocabulary);
  validateBudgets(root);
  return parseNode(root, 'root', allowedUnits) as MathNode;
}

/** Default unit gate, computed once — the derived default list is trusted
 *  (its shape and parser-alignment are pinned by tests). */
const defaultUnits = new Set(defaultStaticVocabulary.units);

/**
 * Resolve the unit gate from the optional vocabulary argument.
 *
 * Omitted vocabulary → derived default list. Provided vocabulary → its units
 * list fully replaces the gate; a missing `units` field means no units. Every
 * custom entry is format-guarded (identifier shape, not parser-shadowed) so a
 * listed string cannot be something the projection can never treat as a unit.
 */
function allowedUnitsFor(vocabulary?: StaticVocabulary): ReadonlySet<string> {
  if (vocabulary === undefined) {
    return defaultUnits;
  }
  const units = (vocabulary.units as readonly string[] | undefined) ?? [];
  for (const entry of units) {
    if (typeof entry !== 'string' || !isUnitSymbolShape(entry)) {
      throw new ValidationError(
        `fromJSON: vocabulary.units entry ${JSON.stringify(entry)} is not a unit symbol (identifier shape required)`,
      );
    }
    if (isParserShadowed(entry)) {
      throw new ValidationError(
        `fromJSON: vocabulary.units entry ${JSON.stringify(entry)} is resolved by the expression parser as a function or constant, not a unit`,
      );
    }
  }
  return new Set(units);
}

/**
 * Iterative budget pre-pass: bounds depth and node count BEFORE the recursive
 * parse, so the recursion can never overflow the stack (its depth is already
 * known to be within budget) and the built tree can never exceed what the
 * fold + evaluation engine can handle. Malformed shapes are left to parseNode
 * — this walk only follows node objects it can descend into.
 */
function validateBudgets(root: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }];
  let count = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const tag = (value as { type?: unknown }).type;
    if (typeof tag !== 'string') continue; // parseNode rejects with the exact shape error
    count += 1;
    if (count > AST_LIMITS.maxNodes) {
      throw new ValidationLimitError(
        'maxNodes',
        AST_LIMITS.maxNodes,
        `fromJSON: envelope exceeds the node budget of ${AST_LIMITS.maxNodes}`,
      );
    }
    if (depth > AST_LIMITS.maxDepth) {
      throw new ValidationLimitError(
        'maxDepth',
        AST_LIMITS.maxDepth,
        `fromJSON: envelope exceeds the depth budget of ${AST_LIMITS.maxDepth} (node at depth ${depth})`,
      );
    }
    const node = value as Record<string, unknown> & { type: string };
    const push = (child: unknown): void => {
      stack.push({ value: child, depth: depth + 1 });
    };
    switch (node.type) {
      case 'op':
      case 'fn': {
        const args = node.args;
        if (Array.isArray(args)) {
          // A single args list longer than the whole budget is over budget
          // no matter what it contains — reject before allocating frames.
          if (args.length > AST_LIMITS.maxNodes) {
            throw new ValidationLimitError(
              'maxNodes',
              AST_LIMITS.maxNodes,
              `fromJSON: an args list of ${args.length} entries alone exceeds the node budget of ${AST_LIMITS.maxNodes}`,
            );
          }
          for (const arg of args) push(arg);
        }
        break;
      }
      case 'group':
        push(node.child);
        break;
      case 'frac':
        push(node.num);
        push(node.den);
        break;
      case 'pow':
        push(node.base);
        push(node.exp);
        break;
      case 'root':
        push(node.radicand);
        if (node.index !== undefined) push(node.index);
        break;
      case 'unit':
        push(node.value);
        break;
      default:
        break; // num/sym/sub are leaves; unknown tags are rejected by parseNode
    }
  }
}

const NODE_TAGS = new Set<NodeJson['type']>([
  'num', 'sym', 'op', 'fn', 'group', 'frac', 'pow', 'root', 'sub', 'unit',
]);

function parseNode(value: unknown, path: string, allowedUnits: ReadonlySet<string>): MathNode | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    throw new ValidationError(`fromJSON: ${path} must be a single node — a flat token row is an invalid state`);
  }
  if (typeof value !== 'object') {
    throw new ValidationError(`fromJSON: ${path} must be a node object`);
  }
  const tag = (value as { type?: unknown }).type;
  if (typeof tag !== 'string' || !NODE_TAGS.has(tag as NodeJson['type'])) {
    throw new ValidationError(`fromJSON: ${path} has unknown type tag ${JSON.stringify(tag)}`);
  }
  const node = value as Record<string, unknown> & { type: NodeJson['type'] };
  switch (node.type) {
    case 'num':
      return new NumberNode(requireNumber(node.value, `${path}.value`));
    case 'sym':
      return new SymbolNode(optString(node.name, `${path}.name`));
    case 'op': {
      const op = optString(node.op, `${path}.op`);
      const args = parseArgs(node.args, `${path}.args`, allowedUnits);
      // Unary operators take exactly one arg — no user-typed state produces
      // any other arity, and the evaluation fold would throw.
      if (UNARY_OPS.has(op) && args.length !== 1) {
        throw new ValidationError(
          `fromJSON: ${path} unary operator '${op}' takes exactly one arg (got ${args.length})`,
        );
      }
      // A >2-arg pow chain has no unambiguous association: the fold is
      // left-associative but every mathjs user types right-associative
      // (`2^3^4` = 2^(3^4)) — a 21-orders-of-magnitude divergence. No editor
      // path produces this shape, so the boundary rejects it.
      if (op === 'pow' && args.length > 2) {
        throw new ValidationError(
          `fromJSON: ${path} pow chains longer than two args have no unambiguous association (got ${args.length})`,
        );
      }
      return new OperatorNode(op, args);
    }
    case 'fn':
      return new FunctionNode(optString(node.name, `${path}.name`), parseArgs(node.args, `${path}.args`, allowedUnits));
    case 'group': {
      if (node.parens !== 'always') {
        throw new ValidationError(`fromJSON: ${path}.parens must be 'always' in v1 (got ${JSON.stringify(node.parens)})`);
      }
      return new GroupNode(parseNode(node.child, `${path}.child`, allowedUnits));
    }
    case 'frac':
      return new FractionNode(parseNode(node.num, `${path}.num`, allowedUnits), parseNode(node.den, `${path}.den`, allowedUnits));
    case 'pow':
      return new PowerNode(parseNode(node.base, `${path}.base`, allowedUnits), parseNode(node.exp, `${path}.exp`, allowedUnits));
    case 'root':
      return new RootNode(parseNode(node.radicand, `${path}.radicand`, allowedUnits), parseNode(node.index, `${path}.index`, allowedUnits));
    case 'sub': {
      const base = optString(node.base, `${path}.base`);
      const sub = optString(node.sub, `${path}.sub`);
      requireSubLabel(base, `${path}.base`, SUB_BASE_PATTERN);
      requireSubLabel(sub, `${path}.sub`, SUB_LABEL_PATTERN);
      return new SubscriptNode(base, sub);
    }
    case 'unit': {
      const unit = optString(node.unit, `${path}.unit`);
      if (unit !== '' && !allowedUnits.has(unit)) {
        throw new ValidationError(`fromJSON: ${path}.unit is not a unit in the vocabulary (got ${JSON.stringify(unit)})`);
      }
      return new UnitNode(parseNode(node.value, `${path}.value`, allowedUnits), unit);
    }
  }
}

// Subscript name identity is the projected SymbolNode name `base + '_' + sub`.
// The projection is injective (distinct stored trees, distinct names) and
// display-stable (the name re-parses as one symbol) only if neither part can
// contain the separator `_` or any character that breaks the flat symbol
// channel. The base must additionally start with a letter — a name like
// `2x_max` would tokenize as a product. Empty parts stay legal (incomplete
// tree).
const SUB_BASE_PATTERN = /^\p{L}[\p{L}\p{N}]*$/u;
const SUB_LABEL_PATTERN = /^[\p{L}\p{N}]+$/u;

function requireSubLabel(value: string, path: string, pattern: RegExp): void {
  if (value !== '' && !pattern.test(value)) {
    throw new ValidationError(`fromJSON: ${path} is not a legal subscript label part (got ${JSON.stringify(value)})`);
  }
}

function parseArgs(value: unknown, path: string, allowedUnits: ReadonlySet<string>): (MathNode | null)[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(`fromJSON: ${path} must be an array`);
  }
  return value.map((arg, i) => parseNode(arg, `${path}[${i}]`, allowedUnits));
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`fromJSON: ${path} must be a finite number (got ${JSON.stringify(value)})`);
  }
  // -0 cannot survive a persistence cycle (JSON.stringify collapses it to
  // 0), so the boundary normalizes it to the only zero the JSON contract can
  // carry rather than rejecting a numerically valid value.
  return Object.is(value, -0) ? 0 : value;
}

function optString(value: unknown, path: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`fromJSON: ${path} must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}
