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
  // 2026-11-11 (`=` session, rules A1–A7): the 12th node type `assign` joins the registry.
  const TYPES = ['num', 'sym', 'sub', 'op', 'fn', 'group', 'frac', 'pow', 'root', 'unit', 'fence', 'assign'] as const;

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
      fence: 'leaf',
      assign: 'slots',
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
      assign: { type: 'assign', lhs: null, rhs: null },
    };
    for (const [type, node] of Object.entries(probes)) {
      const profile = NAV_PROFILES[type as (typeof TYPES)[number]];
      const flow = profile.flow ?? [];
      expect(flow.length).toBeGreaterThan(0);
      for (const slot of flow) expect(slotsOf(node)).toContain(slot);
      // 4b-1 (OA-index-horizontal): `filledOnly` entries may carry the
      // mroot □-index exception; their slot stays in flow.
      for (const rule of profile.filledOnly ?? []) {
        expect(flow).toContain(typeof rule === 'string' ? rule : rule.slot);
      }
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
    // 4a re-pin (OA-visual-trumps): entry dives to the bench station — the
    // filled den's in-token offset 0, never a whole-node caret.
    expect(resolveMove(env, self, 'right', swapped)).toEqual({ kind: 'token', path: ['den'], index: 0 });
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
    // 4a re-pin (ratified bare-root border station): at a lone frac the empty
    // num slot's right exit steps out to the whole-structure after-station.
    expect(resolveMove(env, onNumSlot, 'right')).toEqual({ kind: 'node', path: [], side: 'right' });
    expect(resolveMove(env, onNumSlot, 'right', sideways)).toEqual({ kind: 'token', path: ['den'], index: 0 });
  });

  it('removing the pow chain edges by data changes pow traversal back to exit-only', () => {
    const powEnv = envOf({ v: 1, root: { type: 'pow', base: sym('x'), exp: num(2) } });
    const onBase = nodeCaret(['base']);
    const stackedPow: NavProfile = { children: 'slots', flow: ['base', 'exp'] };
    const swapped: NavRegistry = { ...NAV_PROFILES, pow: stackedPow };
    // 4a re-pin (OA-visual-trumps): the horizontal arrival dives to the
    // exponent's in-token offset 0 (S-043), never a node caret on the token.
    expect(resolveMove(powEnv, onBase, 'right')).toEqual({ kind: 'token', path: ['exp'], index: 0 });
    // 4a: with the chain edge removed by data, the climb exits the lone pow
    // to its whole-structure border station (the ratified after-position).
    expect(resolveMove(powEnv, onBase, 'right', swapped)).toEqual({ kind: 'node', path: [], side: 'right' });
  });

  it('reprofiling op as slot-less makes its geometry exit-only by data', () => {
    const chainEnv = envOf(SEEDS.chain);
    const swapped: NavRegistry = { ...NAV_PROFILES, op: { children: 'slots', flow: [] } };
    // 4a re-pin (OA-visual-trumps): entry into the first cell is its
    // in-token offset 0, not a station "on" the token.
    expect(resolveMove(chainEnv, nodeCaret(), 'right')).toEqual({ kind: 'token', path: [0], index: 0 });
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

    // 4a re-pin (ratified bare-root borders + OA-vertical-default + S-095):
    state = applyOp(state, moveOp('right')); // steps out to the after-fraction station
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'right' });
    state = applyOp(state, moveOp('left')); // S-094: re-enters at the numerator's content END
    expect(state.caret).toEqual({ kind: 'token', path: ['num'], index: 1 });
    state = applyOp(state, moveOp('down')); // the vertical dive: the denominator region's content end
    expect(state.caret).toEqual({ kind: 'token', path: ['den'], index: 1 });
    state = applyOp(state, moveOp('left')); // N1 char-step to the 2's start
    expect(state.caret).toEqual({ kind: 'token', path: ['den'], index: 0 });
    state = applyOp(state, moveOp('left')); // S-095 at root: exits past the whole fraction
    expect(state.caret).toEqual({ kind: 'node', path: [], side: 'left' });
    state = applyOp(state, moveOp('left')); // N3 at the formula start: no-op
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

  it('a lone leaf at the root seeds at its in-token end; from there every direction no-ops or steps (N1)', () => {
    // 4a re-pin (OA-token-end): the seed is the just-typed analog — the
    // token's in-token END (the old node caret's "right edge" reading).
    const state = initSession(SEEDS.num);
    expect(state.caret).toEqual({ kind: 'token', path: [], index: 2 });
    // N3: -> at the very end and up/down on a flat formula are silent no-ops
    for (const dir of DIRS) {
      if (dir === 'left') continue;
      expect(applyOp(state, moveOp(dir))).toBe(state);
    }
    expect(applyOp(state, moveOp('left')).caret).toEqual({ kind: 'token', path: [], index: 1 }); // N1
  });

  it('the far ends of the root row collapse onto the content ends (4a re-pin: N3 + OA-visual-trumps)', () => {
    const state = initSession(SEEDS.chain);
    const atEnd = applyOp(state, { op: 'moveCaret', to: { kind: 'token', path: [2], index: 1 } });
    expect(applyOp(atEnd, moveOp('right'))).toBe(atEnd); // N3: the last token's end IS the formula end
    const atStart = applyOp(state, { op: 'moveCaret', to: { kind: 'token', path: [0], index: 0 } });
    expect(applyOp(atStart, moveOp('left'))).toBe(atStart); // N3 mirrors at the start
    // a structure boundary keeps its seam (the D5 after-station, OA-visual-trumps)
    const fracRow = initSession({ v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(1), den: num(2) }] } });
    const afterFrac = applyOp(fracRow, { op: 'moveCaret', to: { kind: 'row', path: [], index: 2 } });
    expect(applyOp(afterFrac, moveOp('right'))).toBe(afterFrac); // N3 at the seam
    const insideDen = applyOp(fracRow, { op: 'moveCaret', to: { kind: 'token', path: [1, 'den'], index: 1 } });
    const exited = applyOp(insideDen, moveOp('right')); // N4: the slot end exits to the row
    expect(exited.caret).toEqual({ kind: 'row', path: [], index: 2 });
  });

  it('a moved state is a new object carrying the same root and log references', () => {
    const state = initSession(SEEDS.chain); // 4a: the seed sits at the collapsed row end (c's in-token end)
    const moved = applyOp(state, moveOp('left'));
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

  it('traversal enters the numerator (4a re-pin: OA-visual-trumps — the bench offset 0)', () => {
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual({ kind: 'token', path: ['num'], index: 0 });
  });

  it('the numerator flows down into the denominator (4a re-pin: OA-vertical-default content ends)', () => {
    expect(resolveMove(env, nodeCaret(['num']), 'down')).toEqual({ kind: 'token', path: ['den'], index: 1 });
    expect(resolveMove(env, nodeCaret(['den']), 'up')).toEqual({ kind: 'token', path: ['num'], index: 1 });
  });

  it('horizontal movement never crosses sideways between num and den', () => {
    // 4a re-pin: at a lone frac the exits reach the ratified border stations
    // (N4 out; S-095 the mirror) — never the sibling slot.
    expect(resolveMove(env, nodeCaret(['num']), 'right')).toEqual({ kind: 'node', path: [], side: 'right' });
    expect(resolveMove(env, nodeCaret(['den']), 'left')).toEqual({ kind: 'node', path: [], side: 'left' });
    expect(resolveMove(env, nodeCaret(['num']), 'up')).toBe(null);
    expect(resolveMove(env, nodeCaret(['den']), 'down')).toBe(null);
  });

  it('right from the numerator exits to the fraction flank in a glyph zone, never into den (4b-1 re-pin, OA-flank-stations)', () => {
    const rowEnv = envOf(SEEDS.fracInRow); // b * (1/2) * c — frac is cell 1
    // 4b-1 (OA-flank-stations): the exits rest at the frac's edge stations —
    // the spots directly against the structure in the glyph zones — before
    // the neighbor cells' bench ends.
    expect(resolveMove(rowEnv, nodeCaret([1, 'num']), 'right')).toEqual({ kind: 'node', path: [1], side: 'right' });
    expect(resolveMove(rowEnv, { kind: 'node', path: [1], side: 'right' }, 'right')).toEqual({ kind: 'token', path: [2], index: 0 });
    expect(resolveMove(rowEnv, nodeCaret([1, 'den']), 'left')).toEqual({ kind: 'node', path: [1], side: 'left' });
    expect(resolveMove(rowEnv, { kind: 'node', path: [1], side: 'left' }, 'left')).toEqual({ kind: 'token', path: [0], index: 1 });
  });

  it('backward traversal enters the fraction at the NUMERATOR end (4a re-pin: N5/S-094)', () => {
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual({ kind: 'token', path: ['num'], index: 1 });
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
    // 4a re-pin: OA-vertical-default — the den region's content end; the exit
    // reaches the ratified after-station at the lone frac.
    expect(resolveMove(env, slotCaret([], 'num'), 'down')).toEqual({ kind: 'token', path: ['den'], index: 1 });
    expect(resolveMove(env, slotCaret([], 'num'), 'right')).toEqual({ kind: 'node', path: [], side: 'right' });
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

  it('right from the base flows into the exponent and back (4a: S-043/S-096 benches)', () => {
    expect(resolveMove(env, nodeCaret(['base']), 'right')).toEqual({ kind: 'token', path: ['exp'], index: 0 });
    expect(resolveMove(env, nodeCaret(['exp']), 'left')).toEqual({ kind: 'token', path: ['base'], index: 1 });
  });

  it('up/down also addresses the exponent script (4a: OA-vertical-default ends)', () => {
    expect(resolveMove(env, nodeCaret(['base']), 'up')).toEqual({ kind: 'token', path: ['exp'], index: 1 });
    expect(resolveMove(env, nodeCaret(['exp']), 'down')).toEqual({ kind: 'token', path: ['base'], index: 1 });
  });

  it('horizontal arrival dives into a container target; vertical arrival rests at the content end', () => {
    const fracExpEnv = envOf(SEEDS.powFracExp);
    // 4a: the horizontal entry benches at the frac's numerator start; the
    // vertical arrival follows OA-vertical-default — the inner frac's den
    // content end ("rest at the end of the frac", never ON it).
    expect(resolveMove(fracExpEnv, nodeCaret(['base']), 'right')).toEqual({ kind: 'token', path: ['exp', 'num'], index: 0 });
    expect(resolveMove(fracExpEnv, nodeCaret(['base']), 'up')).toEqual({ kind: 'token', path: ['exp', 'den'], index: 1 });
  });
});

describe('root: the index participates only when the tree carries one', () => {
  it('a square root has no index geography (4a re-pin: bench stations)', () => {
    const env = envOf(SEEDS.squareRoot); // root{radicand: 9} — index omitted
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual({ kind: 'token', path: ['radicand'], index: 0 });
    // ← from the root's right boundary rides the radicand (enterRight)
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual({ kind: 'token', path: ['radicand'], index: 1 });
    expect(resolveMove(env, nodeCaret(['radicand']), 'up')).toBe(null);
    expect(resolveMove(env, nodeCaret(['radicand']), 'down')).toBe(null);
  });

  it('an n-th root: the index is a horizontal position at the root head (4b-1, OA-index-horizontal)', () => {
    const env = envOf(SEEDS.nthRoot);
    // 4b-1 re-pin (OA-index-horizontal): entering from the left benches at
    // the root's leftmost horizontal position — the index's offset 0; →
    // at the index's end crosses into the radicand's start; ← at the
    // radicand's start steps back into the index's end.
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual({ kind: 'token', path: ['index'], index: 0 });
    expect(resolveMove(env, { kind: 'token', path: ['index'], index: 1 }, 'right')).toEqual({ kind: 'token', path: ['radicand'], index: 0 });
    expect(resolveMove(env, { kind: 'token', path: ['radicand'], index: 0 }, 'left')).toEqual({ kind: 'token', path: ['index'], index: 1 });
    // 4a re-pin (S-094 right-entry): the right boundary rides the RADICAND,
    // never the front-top index.
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual({ kind: 'token', path: ['radicand'], index: 1 });
    expect(resolveMove(env, nodeCaret(['radicand']), 'up')).toEqual({ kind: 'token', path: ['index'], index: 1 });
    expect(resolveMove(env, nodeCaret(['index']), 'down')).toEqual({ kind: 'token', path: ['radicand'], index: 1 });
  });
});

describe('args rows: continuous flow, gaps stepwise, empty rows reachable', () => {
  it('a flat chain is walked cell by cell; the border overflows rest at the row seams', () => {
    const env = envOf(SEEDS.chain); // add[a, b, c]
    // 4a re-pins (OA-visual-trumps + N1/N2 + N3): entries/dive are bench
    // stations; the tokens step char-wise; the border collapses (no dead-end
    // seam, S-046's session-4 reading void) — one press = one visible move.
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual({ kind: 'token', path: [0], index: 0 });
    expect(resolveMove(env, { kind: 'token', path: [0], index: 1 }, 'right')).toEqual({ kind: 'token', path: [1], index: 0 });
    expect(resolveMove(env, { kind: 'token', path: [1], index: 1 }, 'right')).toEqual({ kind: 'token', path: [2], index: 0 });
    expect(resolveMove(env, { kind: 'token', path: [2], index: 1 }, 'right')).toEqual({ kind: 'token', path: [2], index: 1 }); // N3: the boundary reproduces the origin (the op clamps no-op)
    expect(resolveMove(env, { kind: 'token', path: [2], index: 0 }, 'left')).toEqual({ kind: 'token', path: [1], index: 1 });
    expect(resolveMove(env, { kind: 'token', path: [0], index: 0 }, 'left')).toEqual({ kind: 'token', path: [0], index: 0 }); // N3 (the op clamps no-op)
  });

  it('a row caret (insertion boundary) participates in movement', () => {
    const env = envOf(SEEDS.chain);
    expect(resolveMove(env, rowCaret([], 1), 'right')).toEqual({ kind: 'token', path: [1], index: 0 });
    expect(resolveMove(env, rowCaret([], 1), 'left')).toEqual({ kind: 'token', path: [0], index: 1 });
    expect(resolveMove(env, rowCaret([], 0), 'left')).toBe(null);
  });

  it('gaps are crossed stepwise and empty rows are entered at their insertion point', () => {
    const gapEnv = envOf(SEEDS.gaps); // add[a, null, b]
    expect(resolveMove(envOf(SEEDS.doubleGap), nodeCaret([0]), 'right')).toEqual(rowCaret([], 1));
    expect(resolveMove(envOf(SEEDS.doubleGap), rowCaret([], 1), 'right')).toEqual(rowCaret([], 2));
    expect(resolveMove(gapEnv, rowCaret([], 1), 'right')).toEqual({ kind: 'token', path: [2], index: 0 });
    expect(resolveMove(gapEnv, rowCaret([], 1), 'left')).toEqual({ kind: 'token', path: [0], index: 1 });
    expect(resolveMove(envOf(SEEDS.emptyRow), nodeCaret(), 'right')).toEqual(rowCaret([], 0));
    expect(resolveMove(envOf(SEEDS.emptyRow), rowCaret([], 0), 'right')).toBe(null);
  });
});

describe('deep climbs and jumps through nested structures', () => {
  const env = envOf(SEEDS.canonical); // (5 + 4·3) / 2

  it('horizontal flow walks continuously into nested containers; slot barriers rest the overflow at the innermost row seam', () => {
    expect(resolveMove(env, nodeCaret(), 'right')).toEqual({ kind: 'token', path: ['num', 'child', 0], index: 0 });
    expect(resolveMove(env, nodeCaret(['num', 'child', 0]), 'right')).toEqual({ kind: 'token', path: ['num', 'child', 1, 0], index: 0 });
    // 4b-1 re-pin (OA-flank-stations/OA-fence-flank): the group's parens
    // stop nothing — the content end exits to the post-`)` station INSIDE
    // the numerator (the slot-level flank; the 4a note's "distinct from the
    // after-) position" — that position now exists), one press per visible
    // spot; the next exit leaves the fraction to its after-station.
    expect(resolveMove(env, { kind: 'token', path: ['num', 'child', 1, 1], index: 1 }, 'right')).toEqual({ kind: 'node', path: ['num'], side: 'right' });
    expect(resolveMove(env, { kind: 'node', path: ['num'], side: 'right' }, 'right')).toEqual({ kind: 'node', path: [], side: 'right' });
    // S-094 + OA-vertical-default: ← into the fraction reaches the
    // numerator's INTERIOR end — inside the fences, after the last content
    // char (the `1/(a+b|)` station, distinct from the after-`)` position).
    expect(resolveMove(env, nodeCaret(), 'left')).toEqual({ kind: 'token', path: ['num', 'child', 1, 1], index: 1 });
  });

  it('vertical movement climbs out of rows and rests at the region content end (4a: OA-vertical-default)', () => {
    expect(resolveMove(env, nodeCaret(['num', 'child', 0]), 'down')).toEqual({ kind: 'token', path: ['den'], index: 1 });
    // diving through the group wrapper: INSIDE the fences, after the last
    // content character (the ruled fenced-group arrival, never ON it)
    expect(resolveMove(env, nodeCaret(['den']), 'up')).toEqual({ kind: 'token', path: ['num', 'child', 1, 1], index: 1 });
    expect(resolveMove(env, nodeCaret(['den']), 'right')).toEqual({ kind: 'node', path: [], side: 'right' });
  });

  it('nested rows: up from deep in the denominator reaches the numerator row (4a bench ends)', () => {
    const nested = envOf(SEEDS.nestedRows); // (a+b)/(c+d)
    expect(resolveMove(nested, nodeCaret(['den', 1]), 'up')).toEqual({ kind: 'token', path: ['num', 1], index: 1 });
    expect(resolveMove(nested, nodeCaret(['num', 0]), 'down')).toEqual({ kind: 'token', path: ['den', 1], index: 1 });
  });
});

describe('leaf and string-channel types are exit-only', () => {
  it('sub: the script strings carry no stations', () => {
    const env = envOf(SEEDS.sub);
    for (const dir of DIRS) expect(resolveMove(env, nodeCaret(), dir)).toBe(null);
  });

  it('unit: the value is the left entry; the value/label boundary is ONE seam (OA-unit-single-seam re-pin, I-19)', () => {
    const filled = envOf({ v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } });
    // 4a re-pin: entry benches at the value's in-token offset 0
    expect(resolveMove(filled, nodeCaret(), 'right')).toEqual({ kind: 'token', path: ['value'], index: 0 });
    // 4b-1 re-pin (I-19): the granular unit walks value → label — the
    // value end continues into the label's offset 0 (the old right exit
    // skipped the label letters entirely); the label's offset 0 walks
    // back into the value's right end.
    expect(resolveMove(filled, nodeCaret(['value']), 'right')).toEqual({ kind: 'token', path: [], index: 0 });
    // OA-unit-single-seam: ← from the seam (label offset 0) steps to the value's last interior offset
    expect(resolveMove(filled, { kind: 'token', path: [], index: 0 }, 'left')).toEqual({ kind: 'token', path: ['value'], index: 1 });
    expect(resolveMove(filled, { kind: 'token', path: ['value'], index: 1 }, 'right')).toEqual({ kind: 'token', path: [], index: 0 });
    expect(resolveMove(filled, nodeCaret(['value']), 'down')).toBe(null);
  });
});
