// Internal shared helpers for the engine modules — NOT re-exported by
// engine/index.ts (the public package surface stays byte-stable): one
// implementation of the primitives the rewrite-sustaining modules each grew
// a private copy of.

import type { Envelope, NodeJson } from '../ast/json.js';

import { nodeAt, rowArgs, type Path, type Ref, type SubLabel } from './caret.js';

import type { Position } from './ops.js';

// ——— paths ———

/** Byte-level path equality. */
export const samePath = (a: Path, b: Path): boolean =>
  a.length === b.length && a.every((step, i) => step === b[i]);

// ——— row predicates ———

/** True iff the node is a glyph-less (implicit) multiply row. */
export const isImplicitRow = (node: NodeJson): boolean =>
  node.type === 'op' && (node as { implicit?: boolean }).implicit === true;

/** Envelope-level mirror of the AST's `implicitPairLegal` (src/ast/nodes.ts):
 *  the same predicate the gate and the fold share — left num|group, right
 *  non-num — for the engine's JSON-level seam consumption (OA-seam-family). */
export const pairLegalJson = (left: NodeJson, right: NodeJson): boolean =>
  (left.type === 'num' || left.type === 'group') && right.type !== 'num';

/** The visually adjacent content of the node at `from` on `side` — op rows
 *  are transparent at their edges (descend to the last/first cell). */
export function edgeCell(
  env: Envelope,
  from: Path,
  side: 'first' | 'last',
): { readonly node: NodeJson | null; readonly path: Path } {
  let path = from;
  for (;;) {
    const node = nodeAt(env, path) as NodeJson | null;
    if (node === null || node.type !== 'op') return { node, path };
    const args = rowArgs(node);
    if (args.length === 0) return { node: null, path };
    const idx = side === 'last' ? args.length - 1 : 0;
    if (args[idx] === null) return { node: null, path };
    path = [...path, idx];
  }
}

// ——— positions ———

/** The insert-position a ref addresses (`cellAt`: `fill` a pending null
 *  cell, `row` splice at the index). */
export const refPosition = (ref: Ref, cellAt: 'fill' | 'row'): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'root' };
    case 'slot':
      return { at: 'slot', path: ref.path, slot: ref.slot };
    case 'cell':
      return cellAt === 'fill'
        ? { at: 'fill', path: ref.path, index: ref.index }
        : { at: 'row', path: ref.path, index: ref.index };
  }
};

/** The occupied-replace position a ref addresses. */
export const replacePosOfRef = (ref: Ref): Position => {
  switch (ref.at) {
    case 'root':
      return { at: 'replaceRoot' };
    case 'slot':
      return { at: 'replaceSlot', path: ref.path, slot: ref.slot };
    case 'cell':
      return { at: 'replaceCell', path: ref.path, index: ref.index };
  }
};

// ——— envelope working copies ———

/** Fresh JSON clone of an envelope (no structuredClone in the engine subpath). */
export const cloneEnvelope = (env: Envelope): Envelope => JSON.parse(JSON.stringify(env)) as Envelope;

/** A working copy of `env` with `ref`'s content replaced. */
export function withRefSet(env: Envelope, ref: Ref, node: NodeJson | null): Envelope {
  const after = cloneEnvelope(env);
  if (ref.at === 'root') after.root = node;
  else if (ref.at === 'slot') {
    const owner = nodeAt(after, ref.path) as NodeJson;
    (owner as unknown as Record<string, unknown>)[ref.slot] = node;
  } else {
    rowArgs(nodeAt(after, ref.path) as NodeJson)[ref.index] = node;
  }
  return after;
}

// ——— JSON furniture ———

export const symOf = (name: string): NodeJson => ({ type: 'sym', name }) as NodeJson;

export const unitOf = (value: NodeJson | null, unit: string): NodeJson => ({ type: 'unit', value, unit }) as NodeJson;

export const subOf = (base: string, sub: string): NodeJson => ({ type: 'sub', base, sub }) as NodeJson;

/** The movable close-fence glyph token. */
export const closeFenceToken: NodeJson = { type: 'fence', side: 'close' };

// ——— sub labels (T9) ———

/** A grown sub label must keep its contracted identifier shape (fromJSON
 *  rejects anything else; a shape-breaking glue is a silent no-op). */
export const SUB_BASE_SHAPE = /^\p{L}[\p{L}\p{N}]*$/u;

export const SUB_SUB_SHAPE = /^[\p{L}\p{N}]+$/u;

export const subLabelShapeOk = (label: SubLabel, grown: string): boolean =>
  label === 'base' ? SUB_BASE_SHAPE.test(grown) : SUB_SUB_SHAPE.test(grown);

/** A sub node with one label string replaced (the T9 label-editing shape). */
export const subWithLabel = (node: NodeJson, label: SubLabel, text: string): NodeJson => {
  const labels = node as { base: string; sub: string };
  return label === 'base' ? subOf(text, labels.sub) : subOf(labels.base, text);
};
