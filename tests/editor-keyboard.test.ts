// @vitest-environment jsdom
// Keyboard input (DOM-layer session 2), dispatched as real keydown events on
// the editor root: focus gate + preventDefault, typing (one key = one op =
// one log entry, mid-row swap, rejected/unknown tokens as defined no-ops),
// arrows (never logged), vertical positional memory (record/fire/clear/
// validation), and undo/redo via Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { toJSON } from '../src/ast/serialize.js';
import { envelopeOf, initSession, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';
import { classifyKey, KEYMAP } from '../src/editor/keys.js';
import {
  applyVerticalKey,
  regionKey,
} from '../src/editor/vertical-memory.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const row = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const j = (x: unknown): string => JSON.stringify(x);

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'kb';
  document.body.appendChild(container);
  stubRects({ kb: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope });
  return { controller, container };
}

interface KeyOpts {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function press(container: HTMLElement, key: string, opts: KeyOpts = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
  });
  container.dispatchEvent(ev);
  return ev;
}

const FRAC_ROWS = {
  v: 1,
  root: {
    type: 'frac',
    num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
    den: { type: 'op', op: 'add', args: [sym('c'), sym('d')] },
  },
};

describe('key classification (pure)', () => {
  it('pins the keymap surface and the classifier', () => {
    expect(KEYMAP['5']).toEqual({ t: 'leaf', node: { type: 'num', value: 5 } });
    expect(KEYMAP['a']).toEqual({ t: 'leaf', node: { type: 'sym', name: 'a' } });
    expect(KEYMAP['+']).toEqual({ t: 'operator', fn: 'add' });
    expect(KEYMAP['-']).toEqual({ t: 'operator', fn: 'subtract' });
    expect(KEYMAP['*']).toEqual({ t: 'operator', fn: 'multiply' });
    expect(KEYMAP['/']).toEqual({ t: 'divide' });
    expect(KEYMAP['^']).toEqual({ t: 'pow' });
    expect(KEYMAP['(']).toEqual({ t: 'groupOpen' });
    expect(KEYMAP[')']).toEqual({ t: 'groupClose' });
    expect(KEYMAP['.']).toEqual({ t: 'dot' });
    expect(KEYMAP[',']).toEqual({ t: 'comma' });
    expect(KEYMAP[' ']).toEqual({ t: 'space' }); // S-021/S-022 boundary mechanics

    const ev = (key: string, mods: KeyOpts = {}) => ({ key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift });
    expect(classifyKey(ev('z', { ctrl: true })).kind).toBe('undo');
    expect(classifyKey(ev('z', { meta: true })).kind).toBe('undo');
    expect(classifyKey(ev('y', { ctrl: true })).kind).toBe('redo');
    expect(classifyKey(ev('Z', { ctrl: true, shift: true })).kind).toBe('redo');
    expect(classifyKey(ev('z', { ctrl: true, shift: true })).kind).toBe('redo');
    expect(classifyKey(ev('x', { ctrl: true })).kind).toBe('ignore'); // other modified keys pass through
    expect(classifyKey(ev('a', { alt: true })).kind).toBe('ignore');
    expect(classifyKey(ev('ArrowLeft'))).toEqual({ kind: 'move', dir: 'left' });
    expect(classifyKey(ev('ArrowUp'))).toEqual({ kind: 'move', dir: 'up' });
    expect(classifyKey(ev('5')).kind).toBe('type');
    expect(classifyKey(ev(' ')).kind).toBe('type'); // unknown token, still a typing key
    expect(classifyKey(ev('Enter')).kind).toBe('ignore');
    expect(classifyKey(ev('Tab')).kind).toBe('ignore');
    expect(classifyKey(ev('Escape')).kind).toBe('ignore');
    expect(classifyKey(ev('F5')).kind).toBe('ignore');
    expect(classifyKey(ev('Home')).kind).toBe('ignore');
    expect(classifyKey(ev('PageDown')).kind).toBe('ignore');
  });
});

describe('focus gate + preventDefault', () => {
  it('keys are ignored while the root is not focused; handled keys are preventDefault’ed once focused', () => {
    const { controller, container } = make({ v: 1, root: null });
    const before = controller.getState();

    const unhandled = press(container, '5');
    expect(unhandled.defaultPrevented).toBe(false);
    expect(controller.getState()).toBe(before); // untouched
    press(container, 'ArrowDown');
    press(container, 'z', { ctrl: true });
    expect(controller.getState()).toBe(before);

    container.focus();
    expect(document.activeElement).toBe(container);
    const handled = press(container, '5');
    expect(handled.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(1);

    // keys outside the pinned keymap pass through even while focused
    const enter = press(container, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(controller.getState().log.length).toBe(1);
    const home = press(container, 'Home');
    expect(home.defaultPrevented).toBe(false);
  });
});

describe('typing', () => {
  it('one printable key = exactly one typeToken op = one log entry', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();

    press(container, '5');
    expect(controller.getState().log.length).toBe(1);
    expect(j(controller.getEnvelope().root)).toBe(j(num(5)));
    expect(j(controller.getState().caret)).toBe(j(node([])));

    press(container, '+');
    expect(controller.getState().log.length).toBe(2);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [num(5), null] }));
    expect(j(controller.getState().caret)).toBe(j(row([], 1)));

    press(container, '3');
    expect(controller.getState().log.length).toBe(3);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [num(5), num(3)] }));
  });

  it('a mid-row operator-adjacent caret inserts the glyph literally (S-006: before the existing operator)', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    controller.placeCaret(row([], 1)); // the seam around the + glyph
    container.focus();
    const ev = press(container, '*');
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(1); // one key = one op = one log entry
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'multiply', args: [sym('a'), { type: 'op', op: 'add', args: [null, sym('b')] }] }),
    );
    expect(j(controller.getState().caret)).toBe(j(row([], 1))); // directly after the new glyph
  });

  it('a letter at a row seam glues into the right token (N2/T3): one op, caret inside the glued token', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    controller.placeCaret(row([], 1));
    container.focus();
    const ev = press(container, 'x');
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(1);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), sym('xb')] }));
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: [1], index: 1 }));
  });

  it('an unknown token (space) is a defined no-op', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const before = controller.getState();
    const ev = press(container, ' ');
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before);
    expect(controller.getState().log.length).toBe(0);
  });
});

describe('arrows', () => {
  it('pinned carets move to the expected nav-profile targets and movement never enters the log', () => {
    const { controller, container } = make({ v: 1, root: { type: 'frac', num: sym('a'), den: sym('b') } });
    controller.placeCaret(node(['num']));
    container.focus();

    const down = press(container, 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(j(controller.getState().caret)).toBe(j(node(['den'])));
    expect(controller.getState().log.length).toBe(0);

    press(container, 'ArrowUp');
    expect(j(controller.getState().caret)).toBe(j(node(['num'])));
    expect(controller.getState().log.length).toBe(0);

    // a no-target move is the same-state no-op
    const before = controller.getState();
    press(container, 'ArrowUp'); // up from the numerator: document edge
    expect(controller.getState()).toBe(before);
    press(container, 'ArrowLeft'); // left from a root-level leaf in the num: no target
    expect(controller.getState()).toBe(before);
    expect(controller.getState().log.length).toBe(0);
  });
});

describe('vertical positional memory V2 (session 3 rewrite)', () => {
  it('(a) owner scenario: pinned leaf in a frac num — Down stores the num spot, Left/Left don’t touch the memory, Up arrives at the stored num spot', () => {
    const { controller, container } = make(FRAC_ROWS);
    const start = node(['num', 0]);
    controller.placeCaret(start);
    container.focus();

    press(container, 'ArrowDown');
    expect(j(controller.getState().caret)).toBe(j(node(['den']))); // structural first arrival (no den store yet)
    expect(controller.getVerticalMemory().size).toBe(1); // the num region stored the origin
    press(container, 'ArrowLeft');
    expect(j(controller.getState().caret)).toBe(j(node(['den', 1])));
    press(container, 'ArrowLeft');
    expect(j(controller.getState().caret)).toBe(j(node(['den', 0])));
    expect(controller.getVerticalMemory().size).toBe(1); // horizontal keys never disturb any store
    press(container, 'ArrowUp'); // arriving in the num region: the stored spot wins
    expect(j(controller.getState().caret)).toBe(j(start));
    expect(controller.getState().log.length).toBe(0); // movement never logs
  });

  it('(b) symmetric ping-pong: the return trip leaves the den and stores the den spot, so Down again retraces to it', () => {
    const { controller, container } = make(FRAC_ROWS);
    controller.placeCaret(node(['num', 0]));
    container.focus();
    press(container, 'ArrowDown'); // → den (structural), stores num spot
    press(container, 'ArrowLeft');
    press(container, 'ArrowLeft'); // → node(['den',0])
    press(container, 'ArrowUp'); // → stored num spot node(['num',0])
    expect(j(controller.getState().caret)).toBe(j(node(['num', 0])));
    press(container, 'ArrowDown'); // leaves num (re-stores it), arrives den → stored den spot fires
    expect(j(controller.getState().caret)).toBe(j(node(['den', 0])));
    expect(controller.getState().log.length).toBe(0);
  });

  it('(c) nested regions store independently: inner-level retrace and outer-level ping-pong both fire', () => {
    const env = {
      v: 1,
      root: {
        type: 'frac',
        num: { type: 'frac', num: sym('a'), den: sym('b') },
        den: sym('c'),
      },
    };
    const { controller, container } = make(env);
    const start = node(['num', 'num']);
    controller.placeCaret(start);
    container.focus();

    press(container, 'ArrowDown'); // inner num → inner den (structural first arrival); stores inner-num
    expect(j(controller.getState().caret)).toBe(j(node(['num', 'den'])));
    press(container, 'ArrowUp'); // arrives inner-num region → its store fires
    expect(j(controller.getState().caret)).toBe(j(start));
    press(container, 'ArrowDown'); // again into the inner den
    expect(j(controller.getState().caret)).toBe(j(node(['num', 'den'])));
    press(container, 'ArrowDown'); // inner den → outer den (stores inner-den)
    expect(j(controller.getState().caret)).toBe(j(node(['den'])));
    press(container, 'ArrowUp'); // outer num region has no store yet → structural; stores outer-den
    expect(j(controller.getState().caret)).toBe(j(node(['num'])));
    press(container, 'ArrowDown'); // arrives outer-den region → its store fires
    expect(j(controller.getState().caret)).toBe(j(node(['den'])));
    press(container, 'ArrowUp'); // arrives outer-num region → stored on the way down → fires
    expect(j(controller.getState().caret)).toBe(j(node(['num'])));
    expect(controller.getState().log.length).toBe(0);
  });

  it('(d) in-token indexes are recorded: a vertical round trip retraces the exact in-token caret', () => {
    const env = {
      v: 1,
      root: {
        type: 'frac',
        num: { type: 'op', op: 'add', args: [num(12), sym('x')] },
        den: { type: 'op', op: 'add', args: [num(3), sym('y')] },
      },
    };
    const { controller, container } = make(env);
    const start: Caret = { kind: 'token', path: ['num', 0], index: 1 };
    controller.placeCaret(start);
    container.focus();
    press(container, 'ArrowDown');
    expect(j(controller.getState().caret)).toBe(j(node(['den']))); // structural arrival into the den row
    press(container, 'ArrowUp');
    expect(j(controller.getState().caret)).toBe(j(start)); // stored in-token caret wins
    expect(controller.getState().log.length).toBe(0);
  });

  it('(e) nothing is ever cleared: typed op / undo / redo / click / backspace leave the map intact', () => {
    const env = {
      v: 1,
      root: {
        type: 'frac',
        num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
        den: { type: 'op', op: 'add', args: [sym('c'), null] },
      },
    };
    // typed op
    {
      const { controller, container } = make(env);
      controller.placeCaret(node(['num', 0]));
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      press(container, 'ArrowLeft'); // into the empty den cell
      press(container, '5'); // typed op: tree change — V2 does NOT clear
      expect(controller.getVerticalMemory().size).toBe(1);
      expect(controller.getState().log.length).toBe(1);
      press(container, 'ArrowUp'); // the num store still resolves → fires to the stored spot
      expect(j(controller.getState().caret)).toBe(j(node(['num', 0])));
    }
    // click placement
    {
      const { controller, container } = make(FRAC_ROWS);
      controller.placeCaret(node(['num', 0]));
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      controller.placeCaret(node(['den', 0])); // click path writes no entry, clears nothing
      expect(controller.getVerticalMemory().size).toBe(1);
    }
    // undo / redo / backspace
    {
      const { controller, container } = make(FRAC_ROWS);
      controller.apply({ op: 'moveCaret', to: node(['num', 0]) }); // one log entry
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      press(container, 'z', { ctrl: true });
      expect(controller.getState().log.length).toBe(0);
      expect(controller.getVerticalMemory().size).toBe(1); // undo does not clear
      press(container, 'y', { ctrl: true });
      expect(controller.getVerticalMemory().size).toBe(1); // redo does not clear either
      press(container, 'ArrowDown');
      press(container, 'Backspace'); // a tree-changing key — no clearing
      expect(controller.getVerticalMemory().size).toBe(1);
    }
  });

  it('(f) fire validation: a store whose caret no longer resolves is discarded and the structural target is used', () => {
    const env = toJSON(initSession({ v: 1, root: { type: 'frac', num: sym('a'), den: sym('b') } }).root);
    const res = applyVerticalKey(env, node(['den']), 'up', new Map([[regionKey({ parentPath: [], slot: 'num' }), { kind: 'node', path: ['gone'] }]]));
    expect(res.fired).toBe(false);
    expect(j(res.caret)).toBe(j(node(['num']))); // structural target
    expect(res.mem.has(regionKey({ parentPath: [], slot: 'num' }))).toBe(false); // dangling store discarded
    // a vertical press with no target writes nothing
    const res2 = applyVerticalKey(env, node(['num']), 'up', new Map());
    expect(res2.fired).toBe(false);
    expect(res2.mem.size).toBe(0);
  });
});

describe('undo / redo via keyboard', () => {
  it('Ctrl+Z undoes and Ctrl+Y redoes byte-identically (tree + caret + log); both preventDefault while focused', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, '5');
    press(container, '+');
    const before = j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length]);

    const z = press(container, 'z', { ctrl: true });
    expect(z.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(1);
    expect(j(controller.getEnvelope().root)).toBe(j(num(5)));
    expect(controller.getState().redo.length).toBe(1);

    const y = press(container, 'y', { ctrl: true });
    expect(y.defaultPrevented).toBe(true);
    expect(j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length])).toBe(before);
    expect(controller.getState().redo.length).toBe(0);
  });

  it('Ctrl+Shift+Z redoes as well (both z and Z with shift)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, '5');
    press(container, '+');
    const before = j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length]);
    press(container, 'z', { ctrl: true });
    expect(controller.getState().log.length).toBe(1);
    const zShift = press(container, 'Z', { ctrl: true, shift: true });
    expect(zShift.defaultPrevented).toBe(true);
    expect(j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length])).toBe(before);
  });

  it('a new op after undo clears the redo list — a subsequent redo is a no-op', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, '5');
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe('null');
    press(container, '7'); // new tree-changing op clears redo
    expect(controller.getState().redo.length).toBe(0);
    const before = controller.getState();
    press(container, 'y', { ctrl: true });
    expect(controller.getState()).toBe(before); // redo-on-empty: defined no-op
    expect(j(controller.getEnvelope().root)).toBe(j(num(7)));
    expect(controller.getState().log.length).toBe(1);
  });

  it('redo-on-empty at session start is a no-op', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const before = controller.getState();
    press(container, 'y', { ctrl: true });
    expect(controller.getState()).toBe(before);
    expect(controller.getState().log.length).toBe(0);
  });
});
