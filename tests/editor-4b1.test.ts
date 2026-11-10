// @vitest-environment jsdom
// Rework session 4b-1 — the editor-side acceptance: the OA-vmem-nesting
// scenarios (the owner's three scenarios + the num→num-only chain + the
// sideways-clear semantics, OA-seam-caret-height's pure anchor rule, and
// the M-04 controller-level highlight pin. Every pin names its rule.

import { describe, expect, it } from 'vitest';

import { toJSON } from '../src/ast/serialize.js';

import { initSession, resolveMove, type Caret, type EditingState } from '../src/engine/index.js';
import {
  applyVerticalKey,
  exitedStructures,
  regionKey,
  regionOf,
  wipeSideways,
  type VerticalMemory,
} from '../src/editor/vertical-memory.js';
import { seamAnchorSpec } from '../src/editor/caret-overlay.js';
import { EditorController } from '../src/editor/controller.js';

// @vitest-environment jsdom
const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const j = (x: unknown): string => JSON.stringify(x);
const tok = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path: path as never, index });
const node = (path: (number | string)[], side?: 'left' | 'right'): Caret =>
  ({ kind: 'node', path: path as never, ...(side !== undefined ? { side } : {}) });
const envOfSeeded = (root: unknown) => ({
  v: 1, root: JSON.parse(JSON.stringify(root)) as never,
});

/** `1/(2+(3/4))` — the owner's scenario shape (OA-vmem-nesting). */
const NEST = {
  type: 'frac', num: num(1),
  den: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [num(2), { type: 'frac', num: num(3), den: num(4) }] } },
};
const AT_PLUS = tok(['den', 'child', 0], 1); // "the caret at the +"
const AT_3 = tok(['den', 'child', 1, 'num'], 0); // "resting at the 3"

describe('4b-1 — OA-vmem-nesting: the owner\'s three engine scenarios on 1/(2+(3/4))', () => {
  const env = envOfSeeded(NEST);
  const BIG_DEN = regionKey({ parentPath: [], slot: 'den' });
  const BIG_NUM = regionKey({ parentPath: [], slot: 'num' });
  const NEST_NUM = regionKey({ parentPath: ['den', 'child', 1], slot: 'num' });

  it('scenario 1: caret at the + — ↑ then ↓ returns to the + (big-den\'s own layer memory)', () => {
    let mem: VerticalMemory = new Map();
    const up = applyVerticalKey(env, AT_PLUS, 'up', mem);
    expect(up.fired).toBe(false);
    expect(j(up.mem.get(BIG_DEN))).toBe(j(AT_PLUS)); // the leaving region stores its spot
    const back = applyVerticalKey(env, up.caret, 'down', up.mem);
    expect(back.fired).toBe(true);
    expect(j(back.caret)).toBe(j(AT_PLUS)); // back at the + (N6/V2, unchanged)
  });

  it('scenario 2: → into the nested 3/4 then ↑↓ — the NESTED layer\'s memory wins the descent (the chain)', () => {
    // → into the nested fraction rests at the 3 (the fraction's horizontal interface)
    expect(j(resolveMove(env as never, AT_PLUS, 'right'))).toBe(j(node(['den', 'child', 1], 'left')));
    expect(j(resolveMove(env as never, node(['den', 'child', 1], 'left'), 'right'))).toBe(j(AT_3));
    // ↑ from the 3 stores the nested layer's own memory and climbs to the big num
    let mem: VerticalMemory = new Map();
    const up = applyVerticalKey(env, AT_3, 'up', mem);
    expect(j(up.mem.get(NEST_NUM))).toBe(j(AT_3)); // the nested num region stores
    expect(regionOf(env, up.caret)).toEqual({ parentPath: [], slot: 'num' }); // arrival in the big num
    // ↓ follows the chain into the remembered NESTED position (never the structural
    // seam-after-the-nest, never the nested denominator)
    const down = applyVerticalKey(env, up.caret, 'down', up.mem);
    expect(down.fired).toBe(true);
    expect(j(down.caret)).toBe(j(AT_3)); // "the nested layer's own memory doing its job"
  });

  it('scenario 3: ← out of the nest (the sideways exit clears it) — ↑↓ lands at the +, never a stale nested spot', () => {
    // the ← exit from the nested num reaches the nested fraction's L-flank
    const exit = resolveMove(env as never, AT_3, 'left');
    expect(j(exit)).toBe(j(node(['den', 'child', 1], 'left')));
    // ← again steps over the glyph back to the 2's end (outside the structure)
    const out = resolveMove(env as never, exit!, 'left');
    expect(j(out)).toBe(j(AT_PLUS));
    // OA-vmem-nesting: the sideways exit WIPES the nested layer's memory
    const wiped = wipeSideways(env as never, AT_3, exit!, new Map([[NEST_NUM, AT_3]]));
    expect(wiped.has(NEST_NUM)).toBe(false);
    // the whole exited LAYER dies (OA-vmem-nesting: "that structure's layer
    // memory" — the nested fraction's own num and den regions)
    expect(exitedStructures(env as never, AT_3, exit!)).toEqual([
      { parentPath: ['den', 'child', 1], slot: 'num' },
      { parentPath: ['den', 'child', 1], slot: 'den' },
    ]);
    // with the nested store wiped, ↑↓ runs scenario 1's rules: back at the +
    let mem: VerticalMemory = wiped;
    const up = applyVerticalKey(env, AT_PLUS, 'up', mem);
    const down = applyVerticalKey(env, up.caret, 'down', up.mem);
    expect(down.fired).toBe(true);
    expect(j(down.caret)).toBe(j(AT_PLUS)); // "never into the stale nested spot"
  });

  it('the num→num-only chain rule: only the nested NUMERATOR\'s memory chains (never the nested denominator)', () => {
    const nestDen = tok(['den', 'child', 1, 'den'], 1); // a visited spot in the nested DENOMINATOR
    let mem: VerticalMemory = new Map([[regionKey({ parentPath: ['den', 'child', 1], slot: 'den' }), nestDen]]);
    const up = applyVerticalKey(env, AT_PLUS, 'up', mem); // stores the big-den spot, climbs
    const down = applyVerticalKey(env, up.caret, 'down', up.mem);
    // the descent does NOT dive into the remembered nested denominator — no chain (you
    // can only walk down into the nested numerator), and nothing fired: the structural
    // default would apply; the big-den store (the +) won here first
    expect(j(down.caret)).toBe(j(AT_PLUS));
  });
});

describe('4b-1 — OA-seam-caret-height: the pure anchor-selection rule', () => {
  const root = {
    type: 'op', op: 'add',
    args: [sym('x'), { type: 'frac', num: num(1), den: num(2) }, sym('y')],
  };
  const env = envOfSeeded(root);

  it('a structure flank\'s caret anchors at its LEFT-ADJACENT element (the separator glyph; fallback: itself)', () => {
    // `x + |1/2` — normal text height behind the + (the separator glyph)
    expect(seamAnchorSpec(env as never, node([1], 'left'))).toEqual({ kind: 'separator', rowPath: [], index: 1 });
    // the right flank rides the STRUCTURE itself (its own height: `1+1/2|` — full)
    expect(seamAnchorSpec(env as never, node([1], 'right'))).toEqual({ kind: 'element', path: [1] });
  });

  it('the row seams: the end seam rides the last cell (left-adjacent); a bare start keeps the current element', () => {
    const endEnv = envOfSeeded({ type: 'op', op: 'add', args: [sym('w'), { type: 'frac', num: num(1), den: num(2) }] });
    expect(seamAnchorSpec(endEnv as never, { kind: 'row', path: [], index: 2 })).toEqual({ kind: 'element', path: [1] });
    const startEnv = envOfSeeded({ type: 'op', op: 'add', args: [{ type: 'frac', num: num(1), den: num(2) }, sym('y')] });
    expect(seamAnchorSpec(startEnv as never, { kind: 'row', path: [], index: 0 })).toEqual({ kind: 'element', path: [0] });
    // a pending cell (the glyph's own right edge) rides the separator
    const pendEnv = envOfSeeded({ type: 'op', op: 'add', args: [sym('x'), { type: 'frac', num: num(1), den: num(2) }, null] });
    expect(seamAnchorSpec(pendEnv as never, { kind: 'row', path: [], index: 2 })).toEqual({ kind: 'separator', rowPath: [], index: 2 });
  });

  it('a fence flank anchors per the same rule: the left-of-`(` station rides the separator glyph', () => {
    const gEnv = envOfSeeded({
      type: 'op', op: 'add',
      args: [sym('x'), { type: 'group', parens: 'always', child: sym('b') }, sym('y')],
    });
    expect(seamAnchorSpec(gEnv as never, node([1], 'left'))).toEqual({ kind: 'separator', rowPath: [], index: 1 });
    expect(seamAnchorSpec(gEnv as never, node([1], 'right'))).toEqual({ kind: 'element', path: [1] });
    // no left neighbor (a bare root container): the current element fallback
    const bare = envOfSeeded({ type: 'frac', num: num(1), den: num(2) });
    expect(seamAnchorSpec(bare as never, node([], 'left'))).toEqual({ kind: 'element', path: [] });
  });
});

describe('4b-1 — M-04 (controller level): the after-power D5 highlights THE POWER ONLY', () => {
  const mk = (root: unknown, caret: Caret): { container: HTMLElement; controller: EditorController } => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const controller = new EditorController(container, { envelope: { v: 1, root: root as never } });
    controller.placeCaret(caret);
    container.focus();
    return { container, controller };
  };
  const key = (container: HTMLElement, k: string): void => {
    container.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };

  it('x + a² at the right row-end: BS arms the highlight ON THE msup, and the confirm deletes ONLY the power', () => {
    const root = { type: 'op', op: 'add', args: [sym('x'), { type: 'pow', base: sym('a'), exp: num(2) }] };
    const { container, controller } = mk(root, { kind: 'row', path: [], index: 2 });
    key(container, 'Backspace');
    const painted = [...container.querySelectorAll('.integral-highlight')];
    expect(painted.length).toBe(1);
    expect(painted[0].tagName.toLowerCase()).toBe('msup'); // the power's own extent — never the math/root row
    key(container, 'Backspace');
    expect(j(controller.getEnvelope())).toBe(j({ v: 1, root: { type: 'op', op: 'add', args: [sym('x'), null] } }));
  });

  it('a bare-root power keeps its after-station and D5 (4a OA-lone-root-stations)', () => {
    const root = { type: 'pow', base: sym('a'), exp: num(2) };
    const { container, controller } = mk(root, { kind: 'node', path: [], side: 'right' });
    key(container, 'Backspace');
    const painted = [...container.querySelectorAll('.integral-highlight')];
    expect(painted.length).toBe(1);
    expect(painted[0].tagName.toLowerCase()).toBe('msup');
    key(container, 'Backspace');
    expect(j(controller.getEnvelope())).toBe(j({ v: 1, root: null }));
  });
});

