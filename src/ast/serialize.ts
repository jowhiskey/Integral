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

export function toJSON(root: MathNode): Envelope {
  return { v: 1, root: root.toJSON() };
}

export function fromJSON(envelope: unknown): MathNode {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('fromJSON: envelope must be an object');
  }
  const { v, root } = envelope as { v?: unknown; root?: unknown };
  if (v !== 1) {
    throw new Error(`fromJSON: unsupported envelope version ${JSON.stringify(v) ?? 'undefined'} (expected 1)`);
  }
  if (root === null || root === undefined) {
    throw new Error('fromJSON: envelope root is required');
  }
  return parseNode(root, 'root') as MathNode;
}

const NODE_TAGS = new Set<NodeJson['type']>([
  'num', 'sym', 'op', 'fn', 'group', 'frac', 'pow', 'root', 'sub', 'unit',
]);

function parseNode(value: unknown, path: string): MathNode | null {
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
      return new OperatorNode(optString(node.op, `${path}.op`), parseArgs(node.args, `${path}.args`));
    case 'fn':
      return new FunctionNode(optString(node.name, `${path}.name`), parseArgs(node.args, `${path}.args`));
    case 'group': {
      if (node.parens !== 'always') {
        throw new Error(`fromJSON: ${path}.parens must be 'always' in v1 (got ${JSON.stringify(node.parens)})`);
      }
      return new GroupNode(parseNode(node.child, `${path}.child`));
    }
    case 'frac':
      return new FractionNode(parseNode(node.num, `${path}.num`), parseNode(node.den, `${path}.den`));
    case 'pow':
      return new PowerNode(parseNode(node.base, `${path}.base`), parseNode(node.exp, `${path}.exp`));
    case 'root':
      return new RootNode(parseNode(node.radicand, `${path}.radicand`), parseNode(node.index, `${path}.index`));
    case 'sub':
      return new SubscriptNode(optString(node.base, `${path}.base`), optString(node.sub, `${path}.sub`));
    case 'unit':
      return new UnitNode(parseNode(node.value, `${path}.value`), optString(node.unit, `${path}.unit`));
  }
}

function parseArgs(value: unknown, path: string): (MathNode | null)[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`fromJSON: ${path} must be an array`);
  }
  return value.map((arg, i) => parseNode(arg, `${path}[${i}]`));
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
