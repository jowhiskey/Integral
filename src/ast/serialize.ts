// Envelope-level serialization: toJSON(root) wraps a node in { v: 1, root };
// fromJSON validates the structural invariants and rejects invalid trees.
// Missing/omitted empty slots are accepted on read; toJSON always emits null
// (except root index, which the spec omits when null).

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
  UnitNode,
} from './nodes.js';
import { defaultStaticVocabulary, type StaticVocabulary } from './vocabulary.js';

export function toJSON(root: MathNode | null): Envelope {
  return { v: 1, root: root === null ? null : root.toJSON() };
}

/**
 * Deserialize a formula envelope.
 *
 * Non-empty UnitNode.unit strings must be members of the vocabulary's unit
 * set — shape-only validation let arbitrary identifiers pass as units. Empty
 * strings stay legal (incomplete-tree rule: empty `unit.unit` is a legal
 * in-progress state, like an empty fraction slot). Hosts with custom units
 * pass their own vocabulary; the default is the prefix-aware default static
 * vocabulary, the same single source of truth the editor serves.
 */
export function fromJSON(envelope: unknown, vocabulary?: StaticVocabulary): MathNode | null {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('fromJSON: envelope must be an object');
  }
  const { v, root } = envelope as { v?: unknown; root?: unknown };
  if (v !== 1) {
    throw new Error(`fromJSON: unsupported envelope version ${JSON.stringify(v) ?? 'undefined'} (expected 1)`);
  }
  if (root === null || root === undefined) {
    return null; // empty formula: empty-slot rule extended to the root
  }
  const allowedUnits = new Set(vocabulary?.units ?? defaultStaticVocabulary.units);
  return parseNode(root, 'root', allowedUnits) as MathNode;
}

const NODE_TAGS = new Set<NodeJson['type']>([
  'num', 'sym', 'op', 'fn', 'group', 'frac', 'pow', 'root', 'sub', 'unit',
]);

function parseNode(value: unknown, path: string, allowedUnits: ReadonlySet<string>): MathNode | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    throw new Error(`fromJSON: ${path} must be a single node — a flat token row is an invalid state`);
  }
  if (typeof value !== 'object') {
    throw new Error(`fromJSON: ${path} must be a node object`);
  }
  const tag = (value as { type?: unknown }).type;
  if (typeof tag !== 'string' || !NODE_TAGS.has(tag as NodeJson['type'])) {
    throw new Error(`fromJSON: ${path} has unknown type tag ${JSON.stringify(tag)}`);
  }
  const node = value as Record<string, unknown> & { type: NodeJson['type'] };
  switch (node.type) {
    case 'num':
      return new NumberNode(requireNumber(node.value, `${path}.value`));
    case 'sym':
      return new SymbolNode(optString(node.name, `${path}.name`));
    case 'op':
      return new OperatorNode(optString(node.op, `${path}.op`), parseArgs(node.args, `${path}.args`, allowedUnits));
    case 'fn':
      return new FunctionNode(optString(node.name, `${path}.name`), parseArgs(node.args, `${path}.args`, allowedUnits));
    case 'group': {
      if (node.parens !== 'always') {
        throw new Error(`fromJSON: ${path}.parens must be 'always' in v1 (got ${JSON.stringify(node.parens)})`);
      }
      return new GroupNode(parseNode(node.child, `${path}.child`, allowedUnits));
    }
    case 'frac':
      return new FractionNode(parseNode(node.num, `${path}.num`, allowedUnits), parseNode(node.den, `${path}.den`, allowedUnits));
    case 'pow':
      return new PowerNode(parseNode(node.base, `${path}.base`, allowedUnits), parseNode(node.exp, `${path}.exp`, allowedUnits));
    case 'root':
      return new RootNode(parseNode(node.radicand, `${path}.radicand`, allowedUnits), parseNode(node.index, `${path}.index`, allowedUnits));
    case 'sub':
      return new SubscriptNode(optString(node.base, `${path}.base`), optString(node.sub, `${path}.sub`));
    case 'unit': {
      const unit = optString(node.unit, `${path}.unit`);
      if (unit !== '' && !allowedUnits.has(unit)) {
        throw new Error(`fromJSON: ${path}.unit is not a unit in the vocabulary (got ${JSON.stringify(unit)})`);
      }
      return new UnitNode(parseNode(node.value, `${path}.value`, allowedUnits), unit);
    }
  }
}

function parseArgs(value: unknown, path: string, allowedUnits: ReadonlySet<string>): (MathNode | null)[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`fromJSON: ${path} must be an array`);
  }
  return value.map((arg, i) => parseNode(arg, `${path}[${i}]`, allowedUnits));
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') {
    throw new Error(`fromJSON: ${path} must be a number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function optString(value: unknown, path: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`fromJSON: ${path} must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}
