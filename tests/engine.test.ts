// Editing engine, session 1: ops as values, pure reducer, undo, caret state.
// The tests mirror the session's acceptance criteria:
//  1. purity — previous state byte-identical after any op,
//  2. undo round-trip — N ops then N undos restore the original state
//     exactly, over a corpus covering all node types, incomplete trees, and
//     the empty formula,
//  3. contract validity — every op result round-trips through fromJSON,
//  4. caret validity — the caret resolves after every op,
//  5. op log — length tracks applied ops, undo pops exactly one entry,
//     empty-log undo is a defined no-op.
// Plus unit pins for the relocation rules and the error surface.

import { describe, expect, it } from 'vitest';
import { ValidationError, fromJSON, toJSON, type NodeJson, type StaticVocabulary } from '../src/ast/index.js';
import {
  EngineError,
  applyOp,
  caretResolves,
  envelopeOf,
  initSession,
  slotValue,
  slotsOf,
  undo,
  type EditingState,
  type Op,
  type Path,
} from '../src/engine/index.js';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });

// ——— Corpus ———
// Every node type, incomplete trees (empty slots, empty rows, empty name
// channels), and the empty formula. `initSession` validates each through
// fromJSON, so every seed must be legal contract JSON.

const SEEDS: Record<string, unknown> = {
  empty: { v: 1, root: null },
  num: { v: 1, root: { type: 'num', value: 42 } },
  emptyName: { v: 1, root: { type: 'sym', name: '' } },
  chain: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } },
  canonical: {
    v: 1,
    root: {
      type: 'frac',
      num: {
        type: 'group',
        parens: 'always',
        child: { type: 'op', op: 'add', args: [num(5), { type: 'op', op: 'multiply', args: [num(4), num(3)] }] },
      },
      den: { type: 'num', value: 2 },
    },
  },
  allTypes: {
    v: 1,
    root: {
      type: 'fn',
      name: 'round',
      args: [
        {
          type: 'op',
          op: 'add',
          args: [
            { type: 'pow', base: num(2), exp: { type: 'frac', num: num(1), den: num(2) } },
            { type: 'root', radicand: num(16), index: num(3) },
            { type: 'sub', base: 'x', sub: 'max' },
            { type: 'unit', value: num(50), unit: 'mm' },
          ],
        },
      ],
    },
  },
  zeroArgFn: { v: 1, root: { type: 'fn', name: 'f', args: [] } },
  unary: { v: 1, root: { type: 'op', op: 'unaryMinus', args: [sym('x')] } },
  emptyRow: { v: 1, root: { type: 'op', op: 'add', args: [] } },
  pow2: { v: 1, root: { type: 'op', op: 'pow', args: [sym('x'), sym('y')] } },
  addWithGap: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null] } },
  incompleteFrac: { v: 1, root: { type: 'frac', num: null, den: num(2) } },
  powWithGap: { v: 1, root: { type: 'op', op: 'pow', args: [sym('x'), null] } },
  squareRootNoIndex: { v: 1, root: { type: 'root', radicand: num(9) } },
  groupEmptyChild: { v: 1, root: { type: 'group', parens: 'always', child: null } },
  unitIncomplete: { v: 1, root: { type: 'unit', value: null, unit: '' } },
  fnIncomplete: { v: 1, root: { type: 'fn', name: '', args: [sym('y'), null] } },
};

/** Insert payloads: every node type, complete and incomplete subtrees. */
const PAYLOADS: readonly NodeJson[] = [
  num(7),
  sym('t'),
  { type: 'sub', base: 'a', sub: '1' },
  { type: 'frac', num: null, den: null },
  { type: 'op', op: 'add', args: [num(1), null] },
  { type: 'group', parens: 'always', child: sym('g') },
  { type: 'root', radicand: null },
  { type: 'unit', value: num(1), unit: 'kg' },
  { type: 'fn', name: 'sin', args: [] },
];

// ——— Test-side enumeration (walks the seed JSON; slot knowledge comes from
// the engine's own `slotsOf`, not a second copy of the slot map) ———

/** All (path, node) pairs of a tree, depth-first; the root is path []. */
function allNodes(root: NodeJson | null): { path: Path; node: NodeJson }[] {
  const out: { path: Path; node: NodeJson }[] = [];
  const visit = (node: NodeJson | null, path: Path): void => {
    if (node === null) return;
    out.push({ path, node });
    if (node.type === 'op' || node.type === 'fn') {
      const args = (node as { args: (NodeJson | null)[] }).args ?? [];
      args.forEach((arg, i) => visit(arg, [...path, i]));
      return;
    }
    for (const slot of slotsOf(node)) {
      visit(slotValue(node, slot), [...path, slot]);
    }
  };
  visit(root, []);
  return out;
}

/** Every op position valid for one seed tree: inserts (whole payload set at
 *  each empty slot / each row index / the empty root), deletes (filled root /
 *  filled slots / non-null row entries), and caret targets. Applied in
 *  sequence; ops that become invalid mid-sequence are skipped by the runner,
 *  so the enumerated list is the corpus, not the applied one. */
function opsForTree(seed: unknown, payloads: readonly NodeJson[]): Op[] {
  const root = (seed as { root: NodeJson | null }).root;
  const ops: Op[] = [];
  if (root === null) {
    for (const node of payloads) ops.push({ op: 'insert', node, at: { at: 'root' } });
    ops.push({ op: 'moveCaret', to: { kind: 'empty' } });
    return ops;
  }
  ops.push({ op: 'deleteAt', at: { at: 'root' } });
  for (const { path, node } of allNodes(root)) {
    ops.push({ op: 'moveCaret', to: { kind: 'node', path } });
    if (node.type === 'op' || node.type === 'fn') {
      const args = (node as { args: (NodeJson | null)[] }).args ?? [];
      for (let i = 0; i <= args.length; i += 1) {
        ops.push({ op: 'moveCaret', to: { kind: 'row', path, index: i } });
        for (const payload of payloads) {
          ops.push({ op: 'insert', node: payload, at: { at: 'row', path, index: i } });
        }
      }
      args.forEach((arg, i) => {
        if (arg !== null) ops.push({ op: 'deleteAt', at: { at: 'row', path, index: i } });
      });
      continue;
    }
    for (const slot of slotsOf(node)) {
      if (slotValue(node, slot) === null) {
        ops.push({ op: 'moveCaret', to: { kind: 'slot', path, slot } });
        for (const payload of payloads) {
          ops.push({ op: 'insert', node: payload, at: { at: 'slot', path, slot } });
        }
      } else {
        ops.push({ op: 'deleteAt', at: { at: 'slot', path, slot } });
      }
    }
  }
  return ops;
}

/** Apply one op and assert every per-op acceptance criterion. Null = the op
 *  was invalid for the current tree mid-sequence (typed engine/contract
 *  error, skipped); any other failure rethrows. */
function applyChecked(prev: EditingState, op: Op): EditingState | null {
  const prevTree = JSON.stringify(envelopeOf(prev));
  const prevCaret = JSON.stringify(prev.caret);
  const prevLog = JSON.stringify(prev.log);
  let next: EditingState;
  try {
    next = applyOp(prev, op);
  } catch (error) {
    if (error instanceof EngineError || error instanceof ValidationError) return null;
    throw error;
  }
  // C1: the previous state is byte-identical after the op
  expect(JSON.stringify(envelopeOf(prev))).toBe(prevTree);
  expect(JSON.stringify(prev.caret)).toBe(prevCaret);
  expect(JSON.stringify(prev.log)).toBe(prevLog);
  // C3: the op result round-trips through the contract boundary
  const env = envelopeOf(next);
  expect(JSON.stringify(toJSON(fromJSON(env, next.vocabulary)))).toBe(JSON.stringify(env));
  // C4: the caret resolves in the new tree
  expect(caretResolves(next.root, next.caret)).toBe(true);
  // C5: the log tracks exactly the applied ops
  expect(next.log.length).toBe(prev.log.length + 1);
  expect(next.log[next.log.length - 1]?.op).toEqual(op);
  return next;
}

// ——— Acceptance: corpus round-trip (criteria 1-5 exercised per op) ———

describe('editing engine: N ops then N undos restore the original state', () => {
  for (const [name, seed] of Object.entries(SEEDS)) {
    it(`round-trips: ${name}`, () => {
      const initial = initSession(seed);
      const initialTree = JSON.stringify(envelopeOf(initial));
      const initialCaret = JSON.stringify(initial.caret);

      let state = initial;
      let applied = 0;
      for (const op of opsForTree(seed, PAYLOADS)) {
        const next = applyChecked(state, op);
        if (next !== null) {
          state = next;
          applied += 1;
        }
      }
      expect(applied).toBeGreaterThan(0);
      expect(state.log.length).toBe(applied);

      // C5: undo pops exactly one entry per call
      let undone = state;
      while (undone.log.length > 0) {
        const before = undone.log.length;
        undone = undo(undone);
        expect(undone.log.length).toBe(before - 1);
      }
      // C2: tree JSON byte-identical, caret identical, log empty
      expect(JSON.stringify(envelopeOf(undone))).toBe(initialTree);
      expect(JSON.stringify(undone.caret)).toBe(initialCaret);
      expect(undone.log.length).toBe(0);
    });
  }
});

// ——— Sessions ———

describe('initSession', () => {
  it('defaults to the empty formula with the empty caret', () => {
    const state = initSession();
    expect(JSON.stringify(envelopeOf(state))).toBe('{"v":1,"root":null}');
    expect(state.caret).toEqual({ kind: 'empty' });
    expect(state.log).toEqual([]);
  });

  it('accepts the explicit empty envelope', () => {
    expect(JSON.stringify(envelopeOf(initSession({ v: 1, root: null })))).toBe('{"v":1,"root":null}');
  });

  it('places the initial caret on the root of a non-empty formula', () => {
    expect(initSession(SEEDS.canonical).caret).toEqual({ kind: 'node', path: [] });
  });

  it('validates the envelope through fromJSON', () => {
    expect(() => initSession({ v: 1, root: { type: 'bogus' } })).toThrowError(ValidationError);
    expect(() => initSession({ v: 2, root: null })).toThrowError(ValidationError);
  });
});

// ——— Undo semantics ———

describe('undo', () => {
  it('is a defined no-op on an empty log (same state, no throw)', () => {
    const state = initSession();
    expect(undo(state)).toBe(state);
  });

  it('undoes exactly one op: moveCaret restores the caret without touching the tree', () => {
    let state = initSession(SEEDS.chain);
    const treeBytes = JSON.stringify(envelopeOf(state));
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'row', path: [], index: 2 } });
    expect(state.log.length).toBe(1);
    state = undo(state);
    expect(state.log.length).toBe(0);
    expect(JSON.stringify(state.caret)).toBe(JSON.stringify({ kind: 'node', path: [] }));
    expect(JSON.stringify(envelopeOf(state))).toBe(treeBytes);
  });

  it('pops exactly one entry from a multi-op log', () => {
    let state = initSession({ v: 1, root: null });
    state = applyOp(state, { op: 'insert', node: num(1), at: { at: 'root' } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'root' } });
    expect(state.log.length).toBe(2);
    state = undo(state);
    expect(state.log.length).toBe(1);
    expect(JSON.stringify(envelopeOf(state))).toBe('{"v":1,"root":{"type":"num","value":1}}');
    expect(state.caret).toEqual({ kind: 'node', path: [] });
  });

  it('restores tree and caret byte-identically through deep sequences', () => {
    const initial = initSession(SEEDS.incompleteFrac);
    let state = initial;
    state = applyOp(state, { op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'slot', path: [], slot: 'den' } });
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'slot', path: [], slot: 'den' } });
    state = applyOp(state, { op: 'insert', node: sym('y'), at: { at: 'slot', path: [], slot: 'den' } });
    while (state.log.length > 0) state = undo(state);
    expect(JSON.stringify(envelopeOf(state))).toBe(JSON.stringify(envelopeOf(initial)));
    expect(state.caret).toEqual(initial.caret);
  });
});

// ——— Caret relocation rules ———

describe('caret relocation after ops', () => {
  it('insert at root: the caret sits on the new node; deleteAt at root: empty', () => {
    let state = initSession();
    state = applyOp(state, { op: 'insert', node: num(42), at: { at: 'root' } });
    expect(state.caret).toEqual({ kind: 'node', path: [] });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'root' } });
    expect(state.caret).toEqual({ kind: 'empty' });
  });

  it('insert filling a slot moves a caret waiting in that slot onto the node', () => {
    let state = initSession(SEEDS.incompleteFrac);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'slot', path: [], slot: 'num' } });
    state = applyOp(state, { op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    expect(state.caret).toEqual({ kind: 'node', path: ['num'] });
  });

  it('insert filling a slot leaves an unrelated caret where it was', () => {
    let state = initSession(SEEDS.incompleteFrac);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: ['den'] } });
    state = applyOp(state, { op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    expect(state.caret).toEqual({ kind: 'node', path: ['den'] });
  });

  it('row splice: coordinates at/after the insertion index shift right', () => {
    let state = initSession(SEEDS.chain);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'row', path: [], index: 1 } });
    state = applyOp(state, { op: 'insert', node: num(9), at: { at: 'row', path: [], index: 1 } });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 2 });

    // a node caret on the shifted arg moves with it
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: [2] } });
    state = applyOp(state, { op: 'insert', node: num(8), at: { at: 'row', path: [], index: 2 } });
    expect(state.caret).toEqual({ kind: 'node', path: [3] });
  });

  it('row delete: coordinates after the removal index shift left; positions at it stay', () => {
    let state = initSession(SEEDS.chain);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'row', path: [], index: 2 } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'row', path: [], index: 0 } });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
  });

  it('row delete: a caret inside the removed arg falls back to the seam', () => {
    let state = initSession(SEEDS.chain);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: [1] } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
    // seam at the end stays in range when the last arg was removed
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'row', path: [], index: 1 } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 1 });
  });

  it('slot delete: a caret inside the removed subtree falls back to the now-empty slot', () => {
    let state = initSession(SEEDS.canonical);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: ['num', 'child', 0] } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'slot', path: [], slot: 'num' } });
    expect(state.caret).toEqual({ kind: 'slot', path: [], slot: 'num' });
  });

  it('slot delete: a caret on the removed slot node falls back to the slot', () => {
    let state = initSession(SEEDS.canonical);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: ['num'] } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'slot', path: [], slot: 'num' } });
    expect(state.caret).toEqual({ kind: 'slot', path: [], slot: 'num' });
  });

  it('row splices do not move a caret on the spliced container itself', () => {
    let state = initSession(SEEDS.chain);
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'node', path: [] } });
    state = applyOp(state, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } });
    expect(state.caret).toEqual({ kind: 'node', path: [] });
  });

  it('a caret on a null args entry (empty row slot) survives row splices around it', () => {
    let state = initSession(SEEDS.addWithGap); // op add [a, null]
    state = applyOp(state, { op: 'moveCaret', to: { kind: 'row', path: [], index: 1 } });
    state = applyOp(state, { op: 'insert', node: num(2), at: { at: 'row', path: [], index: 0 } });
    expect(state.caret).toEqual({ kind: 'row', path: [], index: 2 });
    expect(JSON.stringify(envelopeOf(state))).toBe(
      '{"v":1,"root":{"type":"op","op":"add","args":[{"type":"num","value":2},{"type":"sym","name":"a"},null]}}',
    );
  });
});

// ——— Error surface ———

describe('invalid ops throw typed errors and change nothing', () => {
  const expectEngineError = (state: EditingState, op: Op, code: string): void => {
    const tree = JSON.stringify(envelopeOf(state));
    const caret = JSON.stringify(state.caret);
    const logLength = state.log.length;
    let caught: unknown;
    try {
      applyOp(state, op);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe(code);
    expect(JSON.stringify(envelopeOf(state))).toBe(tree);
    expect(JSON.stringify(state.caret)).toBe(caret);
    expect(state.log.length).toBe(logLength);
  };

  it('insert into an occupied slot', () => {
    const state = initSession(SEEDS.canonical);
    expectEngineError(state, { op: 'insert', node: num(1), at: { at: 'slot', path: [], slot: 'den' } }, 'slot-occupied');
  });

  it('insert into a non-empty root', () => {
    expectEngineError(initSession(SEEDS.num), { op: 'insert', node: num(1), at: { at: 'root' } }, 'slot-occupied');
  });

  it('deleteAt on an already-empty slot', () => {
    expectEngineError(
      initSession(SEEDS.incompleteFrac),
      { op: 'deleteAt', at: { at: 'slot', path: [], slot: 'num' } },
      'slot-empty',
    );
  });

  it('deleteAt at a null args entry', () => {
    expectEngineError(
      initSession(SEEDS.powWithGap),
      { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } },
      'slot-empty',
    );
  });

  it('deleteAt at the empty root', () => {
    expectEngineError(initSession(), { op: 'deleteAt', at: { at: 'root' } }, 'slot-empty');
  });

  it('row insert past the end', () => {
    expectEngineError(
      initSession(SEEDS.chain),
      { op: 'insert', node: num(1), at: { at: 'row', path: [], index: 4 } },
      'index-out-of-range',
    );
  });

  it('row delete out of range', () => {
    expectEngineError(
      initSession(SEEDS.chain),
      { op: 'deleteAt', at: { at: 'row', path: [], index: 3 } },
      'index-out-of-range',
    );
  });

  it('positions that do not resolve', () => {
    expectEngineError(
      initSession(SEEDS.chain),
      { op: 'insert', node: num(1), at: { at: 'row', path: [5], index: 0 } },
      'unknown-position',
    );
    // slot on a node that does not own it
    expectEngineError(
      initSession(SEEDS.canonical),
      { op: 'insert', node: num(1), at: { at: 'slot', path: ['den'], slot: 'num' } },
      'unknown-position',
    );
    // row position on a non-row node
    expectEngineError(
      initSession(SEEDS.canonical),
      { op: 'insert', node: num(1), at: { at: 'row', path: ['den'], index: 0 } },
      'unknown-position',
    );
  });

  it('moveCaret to a caret that does not resolve', () => {
    const state = initSession(SEEDS.chain);
    expectEngineError(state, { op: 'moveCaret', to: { kind: 'node', path: [9] } }, 'caret-invalid');
    expectEngineError(state, { op: 'moveCaret', to: { kind: 'empty' } }, 'caret-invalid');
    expectEngineError(initSession(), { op: 'moveCaret', to: { kind: 'node', path: [] } }, 'caret-invalid');
  });

  it('unknown op tag', () => {
    expectEngineError(initSession(), { op: 'transpose' } as unknown as Op, 'unknown-op');
  });
});

describe('contract violations propagate from fromJSON', () => {
  const expectValidationError = (state: EditingState, op: Op): void => {
    const tree = JSON.stringify(envelopeOf(state));
    expect(() => applyOp(state, op)).toThrowError(ValidationError);
    expect(JSON.stringify(envelopeOf(state))).toBe(tree);
  };

  it('rejects inserting a malformed node', () => {
    expectValidationError(initSession(), { op: 'insert', node: { type: 'bogus' } as unknown as NodeJson, at: { at: 'root' } });
  });

  it('rejects the arity violations the contract forbids (op pow 3 args, unary 2 args)', () => {
    expectValidationError(
      initSession(SEEDS.pow2),
      { op: 'insert', node: num(7), at: { at: 'row', path: [], index: 1 } },
    );
    expectValidationError(
      initSession(SEEDS.unary),
      { op: 'insert', node: num(7), at: { at: 'row', path: [], index: 0 } },
    );
  });

  it('rejects a unit outside the session vocabulary', () => {
    const payload: NodeJson = { type: 'unit', value: num(1), unit: 'flurbx' };
    expectValidationError(
      initSession(),
      { op: 'insert', node: payload, at: { at: 'root' } },
    );
  });

  it('accepts the same unit under the session vocabulary passed at init', () => {
    const vocabulary: StaticVocabulary = { constants: [], units: ['flurbx'], functions: [] };
    let state = initSession({ v: 1, root: null }, vocabulary);
    state = applyOp(state, {
      op: 'insert',
      node: { type: 'unit', value: num(1), unit: 'flurbx' },
      at: { at: 'root' },
    });
    expect(JSON.stringify(envelopeOf(state))).toBe(
      '{"v":1,"root":{"type":"unit","value":{"type":"num","value":1},"unit":"flurbx"}}',
    );
    state = undo(state);
    expect(JSON.stringify(envelopeOf(state))).toBe('{"v":1,"root":null}');
  });
});

// ——— Log entries record enough to inspect and undo ———

describe('log entries', () => {
  it('record the op, the pre-op envelope, and the pre-op caret', () => {
    const state = initSession(SEEDS.incompleteFrac);
    const next = applyOp(state, { op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    const entry = next.log[0];
    expect(entry.op).toEqual({ op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    expect(JSON.stringify(entry.before)).toBe(JSON.stringify(envelopeOf(state)));
    expect(entry.caretBefore).toEqual(state.caret);
    expect(next.log.length).toBe(1);
  });
});
