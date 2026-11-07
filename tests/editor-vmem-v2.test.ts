// Vertical memory V2 — pure unit pins (no DOM): regionOf identifies the
// vertically aligned child regions per the nav profiles' vertical edges; a
// vertical keypress stores the leaving region's caret (in-token index
// included) and the arrival region's store wins whenever it still resolves;
// no-op presses write nothing; dangling stores are discarded on read; nothing
// is ever proactively cleared.

import { describe, expect, it } from 'vitest';

import { toJSON } from '../src/ast/serialize.js';

import { initSession, type Caret } from '../src/engine/index.js';
import { applyVerticalKey, regionKey, regionOf, type VerticalMemory } from '../src/editor/vertical-memory.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const row = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const token = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const j = (x: unknown): string => JSON.stringify(x);

const envOf = (root: unknown) => toJSON(initSession({ v: 1, root: root as never }).root);

const FRAC = { type: 'frac', num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] }, den: { type: 'op', op: 'add', args: [sym('c'), sym('d')] } };

describe('regionOf: the vertically aligned child regions per the nav profiles’ vertical edges', () => {
  const env = envOf(FRAC);
  it('frac num/den, pow base/exp, root radicand/index are regions; rows, group children, unit values, the root itself are not', () => {
    expect(regionOf(env, node(['num', 0]))).toEqual({ parentPath: [], slot: 'num' });
    expect(regionOf(env, row(['num'], 1))).toEqual({ parentPath: [], slot: 'num' });
    expect(regionOf(env, node(['den']))).toEqual({ parentPath: [], slot: 'den' });
    expect(regionOf(env, { kind: 'slot', path: [], slot: 'num' })).toEqual({ parentPath: [], slot: 'num' });
    expect(regionOf(env, node([]))).toBe(null); // the root container itself
    const powEnv = envOf({ type: 'pow', base: sym('x'), exp: num(2) });
    expect(regionOf(powEnv, node(['base']))).toEqual({ parentPath: [], slot: 'base' });
    expect(regionOf(powEnv, node(['exp']))).toEqual({ parentPath: [], slot: 'exp' });
    const rootEnv = envOf({ type: 'root', radicand: sym('x'), index: num(3) });
    expect(regionOf(rootEnv, node(['radicand']))).toEqual({ parentPath: [], slot: 'radicand' });
    expect(regionOf(rootEnv, node(['index']))).toEqual({ parentPath: [], slot: 'index' });
    const groupEnv = envOf({ type: 'group', parens: 'always', child: sym('a') });
    expect(regionOf(groupEnv, node(['child']))).toBe(null); // no vertical edges on a group
    const unitEnv = envOf({ type: 'unit', value: num(5), unit: 'mm' });
    expect(regionOf(unitEnv, node(['value']))).toBe(null);
    // deep origin: the region is the frac num even from a leaf inside a nested row cell
    const deepEnv = envOf({ type: 'frac', num: { type: 'op', op: 'multiply', args: [num(2), sym('x')] }, den: num(3) });
    expect(regionOf(deepEnv, node(['num', 0]))).toEqual({ parentPath: [], slot: 'num' });
    expect(regionOf(deepEnv, node(['num', 1]))).toEqual({ parentPath: [], slot: 'num' });
    // deeper nesting: the INNERMOST vertical-edge region wins (pow inside a frac den)
    const nestedEnv = envOf({ type: 'frac', num: num(1), den: { type: 'pow', base: sym('x'), exp: num(2) } });
    expect(regionOf(nestedEnv, node(['den', 'base']))).toEqual({ parentPath: ['den'], slot: 'base' });
    expect(regionOf(nestedEnv, node(['den']))).toEqual({ parentPath: [], slot: 'den' });
    // empty formula
    expect(regionOf(envOf(null), { kind: 'empty' })).toBe(null);
  });
});

describe('applyVerticalKey V2: write on leave, read on arrival, nothing cleared', () => {
  const env = envOf(FRAC);
  const NUM_KEY = regionKey({ parentPath: [], slot: 'num' });
  const DEN_KEY = regionKey({ parentPath: [], slot: 'den' });

  it('a vertical move out of a region stores the caret (in-token index included); arrival uses the store when it resolves', () => {
    let mem: VerticalMemory = new Map();
    // Down from a deep leaf in the num: stores the deep caret under the num region
    let res = applyVerticalKey(env, node(['num', 0]), 'down', mem);
    expect(res.fired).toBe(false);
    expect(j(res.caret)).toBe(j(node(['den']))); // structural first arrival
    expect(j(res.mem.get(NUM_KEY))).toBe(j(node(['num', 0])));
    // Up from a den row cell (after horizontal exploration there): the den region stores the spot on the way out, the num store fires on arrival
    res = applyVerticalKey(env, node(['den', 1]), 'up', res.mem);
    expect(res.fired).toBe(true); // the num store (node(['num',0])) wins over the structural node(['num'])
    expect(j(res.caret)).toBe(j(node(['num', 0])));
    expect(j(res.mem.get(DEN_KEY))).toBe(j(node(['den', 1]))); // the den spot was stored on leaving
    // Down again: arrives den → the den store fires (symmetric ping-pong)
    res = applyVerticalKey(env, node(['num', 0]), 'down', res.mem);
    expect(res.fired).toBe(true);
    expect(j(res.caret)).toBe(j(node(['den', 1])));
    // Up: arrives num → the num store (node(['num',0])) fires
    res = applyVerticalKey(env, node(['den', 1]), 'up', res.mem);
    expect(res.fired).toBe(true);
    expect(j(res.caret)).toBe(j(node(['num', 0])));
  });

  it('in-token positions are stored verbatim and retrace exactly', () => {
    const tokEnv = envOf({
      type: 'frac',
      num: { type: 'op', op: 'add', args: [num(12), sym('x')] },
      den: { type: 'op', op: 'add', args: [num(3), sym('y')] },
    });
    const start = token(['num', 0], 1);
    let res = applyVerticalKey(tokEnv, start, 'down', new Map());
    expect(res.fired).toBe(false);
    expect(j(res.mem.get(regionKey({ parentPath: [], slot: 'num' })))).toBe(j(start));
    res = applyVerticalKey(tokEnv, node(['den']), 'up', res.mem);
    expect(res.fired).toBe(true);
    expect(j(res.caret)).toBe(j(start)); // the in-token index is part of the stored position
  });

  it('deep origins fire (region-level store): a leaf inside a nested row cell in the numerator retraces', () => {
    const deepEnv = envOf({ type: 'frac', num: { type: 'op', op: 'multiply', args: [num(7), sym('x')] }, den: num(3) });
    const start = node(['num', 0]);
    let res = applyVerticalKey(deepEnv, start, 'down', new Map());
    expect(j(res.caret)).toBe(j(node(['den'])));
    res = applyVerticalKey(deepEnv, node(['den']), 'up', res.mem);
    expect(res.fired).toBe(true);
    expect(j(res.caret)).toBe(j(start)); // the deep origin, not the structural node(['num'])
  });

  it('a no-op vertical press writes nothing; a dangling store is discarded on read and the structural target used', () => {
    // no target: up from the numerator at the root edge
    const res = applyVerticalKey(env, node(['num', 0]), 'up', new Map());
    expect(res.fired).toBe(false);
    expect(res.mem.size).toBe(0);
    expect(j(res.caret)).toBe(j(node(['num', 0])));
    // dangling store on the arrival region
    const dangling: VerticalMemory = new Map([[NUM_KEY, { kind: 'node', path: ['gone'] }]]);
    const res2 = applyVerticalKey(env, node(['den']), 'up', dangling);
    expect(res2.fired).toBe(false);
    expect(j(res2.caret)).toBe(j(node(['num']))); // structural default
    expect(res2.mem.has(NUM_KEY)).toBe(false); // discarded
    // ...while a resolving store wins over the structural default
    const live: VerticalMemory = new Map([[NUM_KEY, node(['num', 1])]]);
    const res3 = applyVerticalKey(env, node(['den']), 'up', live);
    expect(res3.fired).toBe(true);
    expect(j(res3.caret)).toBe(j(node(['num', 1])));
  });

  it('horizontal movement never disturbs other regions’ stores (pure: V2 has no horizontal hook at all)', () => {
    let mem: VerticalMemory = new Map();
    let res = applyVerticalKey(env, node(['num', 0]), 'down', mem); // stores num
    mem = res.mem;
    res = applyVerticalKey(env, node(['den', 0]), 'down', mem); // no target at the root edge → writes nothing
    expect(res.mem.size).toBe(1);
    // any horizontal sequence is just resolveMove — the memory is untouched by construction
    expect(res.mem.get(NUM_KEY)).toEqual(node(['num', 0]));
  });
});
