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
  clearCurrentNode,
  memoryNode,
  type VerticalMemory,
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
    expect(KEYMAP[' ']).toBeUndefined(); // space: outside the keymap = unknown token

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

  it('a mid-row operator-adjacent caret swaps via the existing hook (one key = one swap = one log entry)', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    controller.placeCaret(row([], 1)); // seam between a and b: operator-adjacent
    container.focus();
    const ev = press(container, '*');
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(1);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'multiply', args: [sym('a'), sym('b')] }));
    expect(j(controller.getState().caret)).toBe(j(row([], 1))); // junction seam on the new glyph
  });

  it('a rejected token (not-a-typing-point at a row seam) is a defined no-op: no state change, no log growth, no throw', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    controller.placeCaret(row([], 1));
    container.focus();
    const before = controller.getState();
    const ev = press(container, 'x'); // a leaf at a row seam: not a typing point
    expect(ev.defaultPrevented).toBe(true); // still a handled typing key
    expect(controller.getState()).toBe(before); // same state object
    expect(controller.getState().log.length).toBe(0); // no log growth
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

describe('vertical positional memory', () => {
  it('(a) owner scenario: pinned leaf in a frac num — Down, Left, Left, Up jumps back byte-equal (not the structural up)', () => {
    const { controller, container } = make(FRAC_ROWS);
    const start = node(['num', 0]);
    controller.placeCaret(start);
    container.focus();

    press(container, 'ArrowDown');
    expect(j(controller.getState().caret)).toBe(j(node(['den']))); // moved into the den
    expect(controller.getVerticalMemory().size).toBe(1); // recorded on the num row
    press(container, 'ArrowLeft');
    expect(j(controller.getState().caret)).toBe(j(node(['den', 1])));
    press(container, 'ArrowLeft');
    expect(j(controller.getState().caret)).toBe(j(node(['den', 0])));
    expect(controller.getVerticalMemory().size).toBe(1); // the horizontal keys cleared only den-side entries
    press(container, 'ArrowUp');
    // jump-back: byte-equal to the original num position — the structural up would have been node(["num"])
    expect(j(controller.getState().caret)).toBe(j(start));
    expect(j(controller.getState().caret)).not.toBe(j(node(['num'])));
    expect(controller.getState().log.length).toBe(0); // movement never logs
  });

  it('(b) nested retrace: Down through two vertical levels, Up, Up returns through both recorded origins', () => {
    const env = {
      v: 1,
      root: { type: 'frac', num: { type: 'frac', num: sym('a'), den: null }, den: sym('b') },
    };
    const { controller, container } = make(env);
    const start = node(['num', 'num']);
    controller.placeCaret(start);
    container.focus();

    press(container, 'ArrowDown'); // num → den (empty): slot caret in the inner den
    expect(j(controller.getState().caret)).toBe(j({ kind: 'slot', path: ['num'], slot: 'den' }));
    press(container, 'ArrowDown'); // inner den → outer den
    expect(j(controller.getState().caret)).toBe(j(node(['den'])));
    expect(controller.getVerticalMemory().size).toBe(2); // two recorded origins, two distinct nodes
    press(container, 'ArrowUp'); // fires: back to the inner-den origin
    expect(j(controller.getState().caret)).toBe(j({ kind: 'slot', path: ['num'], slot: 'den' }));
    press(container, 'ArrowUp'); // fires again: back to the exact start
    expect(j(controller.getState().caret)).toBe(j(start));
    expect(controller.getState().log.length).toBe(0);
  });

  it('(c) a horizontal key inside the origin node clears only that entry (pure) — and the integration flow shows it', () => {
    // pure: clearCurrentNode deletes ONLY the current node's entry
    const env = toJSON(initSession(FRAC_ROWS).root);
    const numRowKey = memoryNode(env, node(['num', 0]));
    const denRowKey = memoryNode(env, node(['den', 0]));
    expect(numRowKey).not.toBeNull();
    expect(denRowKey).not.toBeNull();
    expect(numRowKey).not.toBe(denRowKey);
    const mem: VerticalMemory = new Map([
      [numRowKey!, { originCaret: node(['num', 0]), direction: 'down' }],
      [denRowKey!, { originCaret: node(['den', 0]), direction: 'up' }],
    ]);
    const cleared = clearCurrentNode(env, node(['num', 0]), mem);
    expect(cleared.has(numRowKey!)).toBe(false);
    expect(cleared.has(denRowKey!)).toBe(true); // everything else survives
    expect(mem.has(numRowKey!)).toBe(true); // original map untouched (pure)

    // integration: after the jump-back, a Left inside the origin node empties the map
    const { controller, container } = make(FRAC_ROWS);
    controller.placeCaret(row(['num'], 1));
    container.focus();
    press(container, 'ArrowDown'); // record on the num row
    expect(controller.getVerticalMemory().size).toBe(1);
    press(container, 'ArrowUp'); // fires: jump-back to the seam pin
    expect(j(controller.getState().caret)).toBe(j(row(['num'], 1)));
    expect(controller.getVerticalMemory().size).toBe(1); // entries persist after firing
    press(container, 'ArrowLeft'); // horizontal key inside the origin node
    expect(controller.getVerticalMemory().size).toBe(0); // its entry is cleared
    expect(j(controller.getState().caret)).toBe(j(node(['num', 0])));
    press(container, 'ArrowDown'); // structural again (no den-side entry), re-records the new origin
    expect(controller.getVerticalMemory().size).toBe(1);
    press(container, 'ArrowUp'); // fires to the re-recorded origin, not the old pin
    expect(j(controller.getState().caret)).toBe(j(node(['num', 0])));
  });

  it('(d) typed op / undo / redo / click each clear the whole map', () => {
    // typed op clears: fill the empty den cell after recording
    {
      const env = {
        v: 1,
        root: {
          type: 'frac',
          num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
          den: { type: 'op', op: 'add', args: [sym('c'), null] },
        },
      };
      const { controller, container } = make(env);
      controller.placeCaret(node(['num', 0]));
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      press(container, 'ArrowLeft'); // into the empty den cell
      expect(j(controller.getState().caret)).toBe(j(row(['den'], 1)));
      press(container, '5'); // typed op: tree change → whole map cleared
      expect(controller.getVerticalMemory().size).toBe(0);
      expect(controller.getState().log.length).toBe(1);
      press(container, 'ArrowUp'); // no entry → structural move, not a jump-back to node(["num",0])
      expect(j(controller.getState().caret)).toBe(j(node(['num'])));
    }
    // click placement clears
    {
      const { controller, container } = make(FRAC_ROWS);
      controller.placeCaret(node(['num', 0]));
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      controller.placeCaret(node(['den', 0])); // click path
      expect(controller.getVerticalMemory().size).toBe(0);
    }
    // undo clears
    {
      const { controller, container } = make(FRAC_ROWS);
      controller.apply({ op: 'moveCaret', to: node(['num', 0]) }); // one log entry
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      press(container, 'z', { ctrl: true });
      expect(controller.getState().log.length).toBe(0);
      expect(controller.getVerticalMemory().size).toBe(0);
    }
    // redo clears (map was already cleared by the undo; redo must not resurrect entries)
    {
      const { controller, container } = make(FRAC_ROWS);
      controller.apply({ op: 'moveCaret', to: node(['num', 0]) });
      container.focus();
      press(container, 'ArrowDown');
      expect(controller.getVerticalMemory().size).toBe(1);
      press(container, 'z', { ctrl: true });
      expect(controller.getVerticalMemory().size).toBe(0);
      press(container, 'y', { ctrl: true });
      expect(controller.getState().log.length).toBe(1);
      expect(controller.getVerticalMemory().size).toBe(0);
    }
  });

  it('(e) fire validation: an entry whose origin caret no longer resolves is discarded and the structural move is used', () => {
    const env = toJSON(initSession({ v: 1, root: { type: 'frac', num: sym('a'), den: sym('b') } }).root);
    const targetKey = memoryNode(env, node(['num'])); // the node an Up from the den lands in
    expect(targetKey).not.toBeNull();
    const dangling: Caret = { kind: 'node', path: ['gone'] };
    const mem: VerticalMemory = new Map([[targetKey!, { originCaret: dangling, direction: 'down' }]]);
    const res = applyVerticalKey(env, node(['den']), 'up', mem);
    expect(res.fired).toBe(false);
    expect(j(res.caret)).toBe(j(node(['num']))); // structural target
    expect(res.mem.has(targetKey!)).toBe(false); // dangling entry discarded
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
