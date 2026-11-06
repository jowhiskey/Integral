// Navigation profiles + relative movement (arc session 2). Acceptance
// criteria, mirrored here:
//  1. registry completeness — a profile exists for each of the 10 types,
//  2. type-blindness — swapping one type's profile data changes that type's
//     movement behavior while the engine's movement code stays untouched,
//  3. movement never logs — undo after moves undoes exactly the last
//     content op and restores its caretBefore,
//  4. caret validity — every successful move over a corpus covering all
//     node types, incomplete trees, and the empty formula resolves,
//  5. no target = byte-identical no-op (same state, no log entry, no throw),
//  6. empty slots are movement targets (slot-caret states),
//  7. the fraction pin: traversal enters the numerator and flows down into
//     the denominator, never sideways,
//  plus pins for the individual geography decisions (pow chain + vertical,
//  root's filled-only index, gaps in args rows, deep climbs and jumps).

import { describe, expect, it } from 'vitest';
import type { NodeJson } from '../src/ast/index.js';
import {
  applyOp,
  caretResolves,
  envelopeOf,
  initSession,
  NAV_PROFILES,
  resolveMove,
  slotsOf,
  slotValue,
  undo,
  type Caret,
  type Envelope,
  type NavDir,
  type NavEdge,
  type NavProfile,
  type NavRegistry,
  type Path,
} from '../src/engine/index.js';

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const DIRS = ['left', 'right', 'up', 'down'] as const;

const nodeCaret = (path: (number | string)[] = []): Caret => ({ kind: 'node', path });
const slotCaret = (path: (number | string)[] = [], slot: string): Caret =>
  ({ kind: 'slot', path, slot } as Caret);
const rowCaret = (path: (number | string)[] = [], index: number): Caret =>
  ({ kind: 'row', path, index } as Caret);

/** Movement corpus seeds: every node type, incomplete trees (empty slots,
 *  empty args rows, gaps, empty name channels), and the empty formula. */
const SEEDS: Record<string, unknown> = {
  empty: { v: 1, root: null },
  num: { v: 1, root: num(42) },
  emptyName: { v: 1, root: { type: 'sym', name: '' } },
  sub: { v: 1, root: { type: 'sub', base: 'x', sub: 'max' } },
  chain: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } },
  gaps: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null, sym('b')] } },
  doubleGap: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null, null] } },
  emptyRow: { v: 1, root: { type: 'op', op: 'add', args: [] } },
  zeroArgFn: { v: 1, root: { type: 'fn', name: 'f', args: [] } },
  fnWithArgs: { v: 1, root: { type: 'fn', name: 'round', args: [sym('x'), num(7)] } },
  canonical: {
    v: 1,
    root: {
      type: 'frac',
      num: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [num(5), { type: 'op', op: 'multiply', args: [num(4), num(3)] }] } },
      den: num(2),
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
  nestedRows: {
    v: 1,
    root: { type: 'frac', num: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, den: { type: 'op', op: 'add', args: [sym('c'), sym('d')] } },
  },
  fracInRow: {
    v: 1,
    root: { type: 'op', op: 'multiply', args: [sym('b'), { type: 'frac', num: num(1), den: num(2) }, sym('c')] },
  },
  incompleteFrac: { v: 1, root: { type: 'frac', num: null, den: num(2) } },
  fracBothEmpty: { v: 1, root: { type: 'frac', num: null, den: null } },
  powEmptyExp: { v: 1, root: { type: 'pow', base: sym('x'), exp: null } },
  powFracExp: { v: 1, root: { type: 'pow', base: sym('x'), exp: { type: 'frac', num: num(1), den: num(2) } } },
  squareRoot: { v: 1, root: { type: 'root', radicand: num(9) } },
  nthRoot: { v: 1, root: { type: 'root', radicand: num(9), index: num(3) } },
  groupEmptyChild: { v: 1, root: { type: 'group', parens: 'always', child: null } },
  unitIncomplete: { v: 1, root: { type: 'unit', value: null, unit: '' } },
};

const envOf = (seed: unknown): Envelope => envelopeOf(initSession(seed));
const moveOp = (dir: NavDir) => ({ op: 'move', dir } as const);

// ——— Helpers ———

function stationsOf(root: NodeJson | null): Caret[] {
  const out: Caret[] = [];
  const visit = (node: NodeJson | null, path: Path): void => {
    if (node === null) return;
    out.push({ kind: 'node', path });
    if (node.type === 'op' || node.type === 'fn') {
      const args = (node as unknown as { args: (NodeJson | null)[] }).args ?? [];
      for (let i = 0; i <= args.length; i += 1) out.push({ kind: 'row', path, index: i });
      args.forEach((arg, i) => visit(arg, [...path, i]));
      return;
    }
    for (const slot of slotsOf(node)) {
      const child = slotValue(node, slot);
      if (child === null) out.push({ kind: 'slot', path, slot });
      else visit(child, [...path, slot]);
    }
  };
  visit(root, []);
  return out;
}

// ——— Criterion 1: registry completeness ———

describe('nav profile registry', () => {
  const TYPES = ['num', 'sym', 'sub', 'op', 'fn', 'group', 'frac', 'pow', 'root', 'unit'] as const;

  it('has exactly one profile per node type', () => {
    expect(Object.keys(NAV_PROFILES).sort()).toEqual([...TYPES].sort());
  });

  it('declares the right child addressing per type', () => {
    const expectChildren: Record<(typeof TYPES)[number], NavProfile['children']> = {
      num: 'leaf',
      sym: 'leaf',
      sub: 'leaf',
      op: 'args',
      fn: 'args',
      group: 'slots',
      frac: 'slots',
      pow: 'slots',
      root: 'slots',
      unit: 'slots',
    };
    for (const type of TYPES) expect(NAV_PROFILES[type].children).toBe(expectChildren[type]);
  });

  it('only references slots the type owns, and filledOnly slots are in flow', () => {
    const probes: Record<string, NodeJson> = {
      group: { type: 'group', parens: 'always', child: null },
      frac: { type: 'frac', num: null, den: null },
      pow: { type: 'pow', base: null, exp: null },
      root: { type: 'root', radicand: null, index: null },
      unit: { type: 'unit', value: null, unit: '' },
    };
    for (const [type, node] of Object.entries(probes)) {
      const profile = NAV_PROFILES[type as (typeof TYPES)[number]];
      const flow = profile.flow ?? [];
      expect(flow.length).toBeGreaterThan(0);
      for (const slot of flow) expect(slotsOf(node)).toContain(slot);
      for (const slot of profile.filledOnly ?? []) expect(flow).toContain(slot);
      for (const edge of [...(profile.horizontal ?? []), ...(profile.vertical ?? [])] as NavEdge[]) {
        expect(flow).toContain(edge.from);
        expect(flow).toContain(edge.to);
      }
    }
  });
});

// ——— Criterion 2: type-blindness — profile swaps change behavior ———

describe('profile swaps change movement with the engine untouched', () => {
  const env = envOf(SEEDS.incompleteFrac); // frac{num:null, den:2}
  const self = nodeCaret();
  const onDen = nodeCaret(['den']);

  it('reversed frac flow: entry lands in the denominator instead of the numerator', () => {
    const swapped: NavRegistry = {
      ...NAV_PROFILES,
      frac: {
        children: 'slots',
        flow: ['den', 'num'],
        vertical: [
          { from: 'den', dir: 'down', to: 'num' },
          { from: 'num', dir: 'up', to: 'den' },
        ],
      },
    };
    expect(resolveMove(env, self, 'right')).toEqual(slotCaret([], 'num'));
    expect(resolveMove(env, self, 'right', swapped)).toEqual(nodeCaret(['den']));
    // and the reversed vertical edge: down from the denominator now enters the numerator
    expect(resolveMove(env, onDen, 'down')).toBe(null);
    expect(resolveMove(env, onDen, 'down', swapped)).toEqual(slotCaret([], 'num')); // num is empty here
  });

  it('a horizontal edge added by data alone unlocks sideways flow the default forbids', () => {
    const sideways: NavRegistry = {
      ...NAV_PROFILES,
      frac: {
        ...NAV_PROFILES.frac,
        horizontal: [
          { from: 'num', dir: 'right', to: 'den' },
          { from: 'den', dir: 'left', to: 'num' },
        ],
      },
    };
    const onNumSlot = slotCaret([], 'num');
    expect(resolveMove(env, onNumSlot, 'right')).toBe(null);
    expect(resolveMove(env, onNumSlot, 'right', sideways)).toEqual(nodeCaret(['den']));
  });

  it('removing the pow chain edges by data changes pow traversal back to exit-only', () => {
    const powEnv = envOf({ v: 1, root: { type: 'pow', base: sym('x'), exp: num(2) } });
    const onBase = nodeCaret(['base']);
    const stackedPow: NavProfile = { children: 'slots', flow: ['base', 'exp'] };
    const swapped: NavRegistry = { ...NAV_PROFILES, pow: stackedPow };
    expect(resolveMove(powEnv, onBase, 'right')).toEqual(nodeCaret(['exp']));
    expect(resolveMove(powEnv, onBase, 'right', swapped)).toBe(null);
  });

  it('reprofiling op as slot-less makes its geometry exit-only by data', () => {
    const chainEnv = envOf(SEEDS.chain);
    const swapped: NavRegistry = { ...NAV_PROFILES, op: { children: 'slots', flow: [] } };
    expect(resolveMove(chainEnv, nodeCaret(), 'right')).toEqual(nodeCaret([0]));
    expect(resolveMove(chainEnv, nodeCaret(), 'right', swapped)).toBe(null);
  });
});

// ——— Criterion 3: movement never logs; undo undoes exactly the content op ———

describe('movement never enters the undo log', () => {
  it('moves keep the log untouched and undo restores the content op pre-state', () => {
    let state = initSession(SEEDS.incompleteFrac); // frac{num:null, den:2}, caret self
    state = applyOp(state, { op: 'insert', node: num(3), at: { at: 'slot', path: [], slot: 'num' } });
    expect(state.log.length).toBe(1);
    const insertEntry = state.log[0];
    const logRef = state.log;

    state = applyOp(state, moveOp('right')); // moves onto the inserted 3
    expect(state.caret).toEqual(nodeCaret(['num']));
    state = applyOp(state, moveOp('down')); // flows down into the denominator
    expect(state.caret).toEqual(nodeCaret(['den']));
    state = applyOp(state, moveOp('left')); // no target at root: no-op
    expect(state.log).toBe(logRef);
    expect(state.log.length).toBe(1);

    const undone = undo(state);
    expect(undone.log.length).toBe(0);
    expect(JSON.stringify(envelopeOf(undone))).toBe(JSON.stringify(envelopeOf(initSession(SEEDS.incompleteFrac))));
    expect(undone.caret).toEqual(insertEntry.caretBefore); // the caret before the insert
  });

  it('a long move bath after several content ops still undoes one content op at a time', () => {
    let state = initSession(); // empty
    state = applyOp(state, { op: 'insert', node: { type: 'frac', num: null, den: null }, at: { at: 'root' } });
    state = applyOp(state, moveOp('right')); // into the empty numerator
    state = applyOp(state, { op: 'insert', node: num(7), at: { at: 'slot', path: [], slot: 'num' } });
    state = applyOp(state, moveOp('down')); // into the empty denominator
    state = applyOp(state, moveOp('up')); // back up into the numerator
    state = applyOp(state, moveOp('left'));
    expect(state.log.length).toBe(2); // exactly the two inserts

    let undone = undo(state); // pops the second insert
    expect(undone.caret).toEqual(slotCaret([], 'num')); // moveCaret-like: back in the emptied slot
    undone = undo(undone); // pops the first insert
    expect(JSON.stringify(envelopeOf(undone))).toBe('{"v":1,"root":null}');
    expect(undone.caret).toEqual({ kind: 'empty' });
  });
});

// ——— Criterion 4: caret validity across a movement corpus ———

describe('movement corpus: every move yields a resolving caret and an untouched tree', () => {
  for (const [name, seed] of Object.entries(SEEDS)) {
    it(`covers every station and direction: ${name}`, () => {
      const root = (seed as { root: NodeJson | null }).root;
      const stations: Caret[] = root === null ? [{ kind: 'empty' }] : stationsOf(root);
      expect(stations.length).toBeGreaterThan(0);
      let moves = 0;
      for (const station of stations) {
        for (const dir of DIRS) {
          const base = initSession(seed);
          const treeBytes = JSON.stringify(envelopeOf(base));
          const state = applyOp(base, { op: 'moveCaret', to: station });
          const next = applyOp(state, moveOp(dir));
          // movement never touches tree or log:
          expect(JSON.stringify(envelopeOf(next))).toBe(treeBytes);
          expect(JSON.stringify(envelopeOf(state))).toBe(treeBytes);
          expect(next.log).toBe(state.log);
          // the resulting caret is always valid:
          expect(caretResolves(next.root, next.caret)).toBe(true);
          if (next !== state) moves += 1;
        }
      }
      // anything with addressable internals must offer at least one movement
      const rootChildren = root !== null ? NAV_PROFILES[root.type].children : null;
      if (rootChildren !== null && rootChildren !== 'leaf') expect(moves).toBeGreaterThan(0);
    });
  }
});

// ——— Criterion 5: no target = byte-identical no-op ———

describe('no-target movement is a defined no-op', () => {
  it('every direction on the empty formula returns the exact same state', () => {
    const state = initSession();
    expect(state.caret).toEqual({ kind: 'empty' });
    for (const dir of DIRS) expect(applyOp(state, moveOp(dir))).toBe(state);
  });

  it('a lone leaf at the root has no target in any direction', () => {
    const state = initSession(SEEDS.num);
    for (const dir of DIRS) expect(applyOp(state, moveOp(dir))).toBe(state);
  });

  it('the far end of the root row has no target', () => {
    const state = initSession(SEEDS.chain);
    const atEnd = applyOp(state, { op: 'moveCaret', to: nodeCaret([2]) });
    expect(applyOp(atEnd, moveOp('right'))).toBe(atEnd);
    const atStart = applyOp(state, { op: 'moveCaret', to: nodeCaret([0]) });
    expect(applyOp(atStart, moveOp('left'))).toBe(atStart);
  });

  it('a moved state is a new object carrying the same root and log references', () => {
    const state = initSession(SEEDS.chain);
    const moved = applyOp(state, moveOp('right'));
    expect(moved).not.toBe(state);
    expect(moved.root).toBe(state.root);
    expect(moved.log).toBe(state.log);
  });

  it('a malformed direction is a typed engine error, not a silent move', () => {
    const state = initSession(SEEDS.num);
    const before = JSON.stringify(envelopeOf(state));
    expect(() => applyOp(state, { op: 'move', dir: 'diagonal' as unknown as NavDir })).toThrowError(/unknown-op|direction/);
    expect(JSON.stringify(envelopeOf(state))).toBe(before);
  });
});

// ——— Criterion 7: the fraction pin ———

describe('the fraction pin: enter the numerator, flow down, never sideways', () => {
  const env = envOf({ v: 1, root: { type: 'frac', num: num(1), den: num(2) } });

  it('traversal enters the numerator', () => {
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(nodeCaret(['num']));
  });

  it('the numerator flows down into the denominator', () => {
    expect(resolveMove(env, nodeCaret(['num']), 'down')).toEqual(nodeCaret(['den']));
    expect(resolveMove(env, nodeCaret(['den']), 'up')).toEqual(nodeCaret(['num']));
  });

  it('horizontal movement never crosses sideways between num and den', () => {
    expect(resolveMove(env, nodeCaret(['num']), 'right')).toBe(null);
    expect(resolveMove(env, nodeCaret(['den']), 'left')).toBe(null);
    expect(resolveMove(env, nodeCaret(['num']), 'up')).toBe(null);
    expect(resolveMove(env, nodeCaret(['den']), 'down')).toBe(null);
  });

  it('right from the numerator exits past the fraction to the parent right, not into den', () => {
    const rowEnv = envOf(SEEDS.fracInRow); // b * (1/2) * c — frac is cell 1
    expect(resolveMove(rowEnv, nodeCaret([1, 'num']), 'right')).toEqual(nodeCaret([2]));
    expect(resolveMove(rowEnv, nodeCaret([1, 'den']), 'left')).toEqual(nodeCaret([0]));
  });

  it('backward traversal enters the fraction at the denominator end', () => {
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual(nodeCaret(['den']));
  });
});

// ——— Criterion 6: empty slots are movement targets ———

describe('empty slots are movement targets', () => {
  it('landing in an empty numerator yields the num slot-caret', () => {
    const env = envOf(SEEDS.incompleteFrac); // frac{num:null, den:2}
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(slotCaret([], 'num'));
    expect(resolveMove(env, nodeCaret(['den']), 'up')).toEqual(slotCaret([], 'num'));
  });

  it('from inside the empty slot the geography continues', () => {
    const env = envOf(SEEDS.incompleteFrac);
    expect(resolveMove(env, slotCaret([], 'num'), 'down')).toEqual(nodeCaret(['den']));
    expect(resolveMove(env, slotCaret([], 'num'), 'right')).toBe(null); // at root: no exit target
  });

  it('applies per type: group child, unit value, pow exp', () => {
    expect(resolveMove(envOf(SEEDS.groupEmptyChild), nodeCaret(), 'right')).toEqual(slotCaret([], 'child'));
    expect(resolveMove(envOf(SEEDS.unitIncomplete), nodeCaret(), 'right')).toEqual(slotCaret([], 'value'));
    expect(resolveMove(envOf(SEEDS.powEmptyExp), nodeCaret(['base']), 'right')).toEqual(slotCaret([], 'exp'));
    expect(resolveMove(envOf({ v: 1, root: { type: 'frac', num: num(1), den: null } }), nodeCaret(['num']), 'down')).toEqual(slotCaret([], 'den'));
  });

  it('gaps in args rows rest at the row caret — the only representable position of an empty cell', () => {
    const env = envOf(SEEDS.gaps); // add[a, null, b]
    expect(resolveMove(env, nodeCaret([0]), 'right')).toEqual(rowCaret([], 1));
    expect(resolveMove(env, nodeCaret([2]), 'left')).toEqual(rowCaret([], 1));
  });
});

// ——— Geography pins per type (judgment calls, individually pinned) ———

describe('pow: chained horizontally and vertical as a raised script', () => {
  const env = envOf({ v: 1, root: { type: 'pow', base: sym('x'), exp: num(2) } });

  it('right from the base flows into the exponent and back', () => {
    expect(resolveMove(env, nodeCaret(['base']), 'right')).toEqual(nodeCaret(['exp']));
    expect(resolveMove(env, nodeCaret(['exp']), 'left')).toEqual(nodeCaret(['base']));
  });

  it('up/down also addresses the exponent script', () => {
    expect(resolveMove(env, nodeCaret(['base']), 'up')).toEqual(nodeCaret(['exp']));
    expect(resolveMove(env, nodeCaret(['exp']), 'down')).toEqual(nodeCaret(['base']));
  });

  it('horizontal arrival dives into a container target; vertical arrival jumps onto it', () => {
    const fracExpEnv = envOf(SEEDS.powFracExp);
    expect(resolveMove(fracExpEnv, nodeCaret(['base']), 'right')).toEqual(nodeCaret(['exp', 'num']));
    expect(resolveMove(fracExpEnv, nodeCaret(['base']), 'up')).toEqual(nodeCaret(['exp']));
  });
});

describe('root: the index participates only when the tree carries one', () => {
  it('a square root has no index geography', () => {
    const env = envOf(SEEDS.squareRoot); // root{radicand: 9} — index omitted
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(nodeCaret(['radicand']));
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual(nodeCaret(['radicand']));
    expect(resolveMove(env, nodeCaret(['radicand']), 'up')).toBe(null);
    expect(resolveMove(env, nodeCaret(['radicand']), 'down')).toBe(null);
  });

  it('an n-th root: radicand is the entry, the index a vertical and backward target', () => {
    const env = envOf(SEEDS.nthRoot);
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(nodeCaret(['radicand']));
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual(nodeCaret(['index']));
    expect(resolveMove(env, nodeCaret(['radicand']), 'up')).toEqual(nodeCaret(['index']));
    expect(resolveMove(env, nodeCaret(['index']), 'down')).toEqual(nodeCaret(['radicand']));
  });
});

describe('args rows: continuous flow, gaps stepwise, empty rows reachable', () => {
  it('a flat chain is walked cell by cell', () => {
    const env = envOf(SEEDS.chain); // add[a, b, c]
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(nodeCaret([0]));
    expect(resolveMove(env, nodeCaret([0]), 'right')).toEqual(nodeCaret([1]));
    expect(resolveMove(env, nodeCaret([1]), 'right')).toEqual(nodeCaret([2]));
    expect(resolveMove(env, nodeCaret([2]), 'right')).toBe(null);
    expect(resolveMove(env, nodeCaret([2]), 'left')).toEqual(nodeCaret([1]));
    expect(resolveMove(env, nodeCaret([0]), 'left')).toBe(null);
  });

  it('a row caret (insertion boundary) participates in movement', () => {
    const env = envOf(SEEDS.chain);
    expect(resolveMove(env, rowCaret([], 1), 'right')).toEqual(nodeCaret([1]));
    expect(resolveMove(env, rowCaret([], 1), 'left')).toEqual(nodeCaret([0]));
    expect(resolveMove(env, rowCaret([], 0), 'left')).toBe(null);
  });

  it('gaps are crossed stepwise and empty rows are entered at their insertion point', () => {
    const gapEnv = envOf(SEEDS.gaps); // add[a, null, b]
    expect(resolveMove(envOf(SEEDS.doubleGap), nodeCaret([0]), 'right')).toEqual(rowCaret([], 1));
    expect(resolveMove(envOf(SEEDS.doubleGap), rowCaret([], 1), 'right')).toEqual(rowCaret([], 2));
    expect(resolveMove(gapEnv, rowCaret([], 1), 'right')).toEqual(nodeCaret([2]));
    expect(resolveMove(gapEnv, rowCaret([], 1), 'left')).toEqual(nodeCaret([0]));
    expect(resolveMove(envOf(SEEDS.emptyRow), nodeCaret(), 'right')).toEqual(rowCaret([], 0));
    expect(resolveMove(envOf(SEEDS.emptyRow), rowCaret([], 0), 'right')).toBe(null);
  });
});

describe('deep climbs and jumps through nested structures', () => {
  const env = envOf(SEEDS.canonical); // (5 + 4·3) / 2

  it('horizontal flow walks continuously into nested containers', () => {
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual(nodeCaret(['num', 'child', 0]));
    expect(resolveMove(env, nodeCaret(['num', 'child', 0]), 'right')).toEqual(nodeCaret(['num', 'child', 1, 0]));
    expect(resolveMove(env, nodeCaret(['num', 'child', 1, 1]), 'right')).toBe(null); // doc right edge
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual(nodeCaret(['den']));
  });

  it('vertical movement climbs out of rows and jumps onto the paired slot', () => {
    expect(resolveMove(env, nodeCaret(['num', 'child', 0]), 'down')).toEqual(nodeCaret(['den']));
    expect(resolveMove(env, nodeCaret(['den']), 'up')).toEqual(nodeCaret(['num'])); // jump onto the group
    expect(resolveMove(env, nodeCaret(['den']), 'right')).toBe(null);
  });

  it('nested rows: up from deep in the denominator reaches the numerator row', () => {
    const nested = envOf(SEEDS.nestedRows); // (a+b)/(c+d)
    expect(resolveMove(nested, nodeCaret(['den', 1]), 'up')).toEqual(nodeCaret(['num']));
    expect(resolveMove(nested, nodeCaret(['num', 0]), 'down')).toEqual(nodeCaret(['den']));
  });
});

describe('leaf and string-channel types are exit-only', () => {
  it('sub: the script strings carry no stations', () => {
    const env = envOf(SEEDS.sub);
    for (const dir of DIRS) expect(resolveMove(env, nodeCaret(), dir)).toBe(null);
  });

  it('unit: the value is traversable, the unit block itself is exit-only', () => {
    const filled = envOf({ v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } });
    expect(resolveMove(filled, nodeCaret(), 'right')).toEqual(nodeCaret(['value']));
    expect(resolveMove(filled, nodeCaret(['value']), 'right')).toBe(null);
    expect(resolveMove(filled, nodeCaret(['value']), 'down')).toBe(null);
  });
});
