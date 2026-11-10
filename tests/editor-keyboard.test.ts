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
  /** Physical key position (KeyboardEvent.code) — T8 dead-key identification. */
  code?: string;
}

function press(container: HTMLElement, key: string, opts: KeyOpts = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    code: opts.code,
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
    // K2/K3 (session 5): Enter/Tab/Escape are the blur-commit family
    expect(classifyKey(ev('Enter'))).toEqual({ kind: 'commit' });
    expect(classifyKey(ev('Tab'))).toEqual({ kind: 'commit' });
    expect(classifyKey(ev('Escape'))).toEqual({ kind: 'commit' });
    expect(classifyKey(ev('F5')).kind).toBe('ignore');
    // K1 (session 5): Home/End boundary moves; the Ctrl variants stay unbound
    expect(classifyKey(ev('Home'))).toEqual({ kind: 'boundary', side: 'start' });
    expect(classifyKey(ev('End'))).toEqual({ kind: 'boundary', side: 'end' });
    expect(classifyKey(ev('Home', { ctrl: true })).kind).toBe('ignore');
    expect(classifyKey(ev('End', { ctrl: true })).kind).toBe('ignore');
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
    // (Enter/Home/End are handled since rework session 5 — K2/K3 commit+blur,
    // K1 boundary — pinned in editor-session5.test.ts)
    const pageUp = press(container, 'PageUp');
    expect(pageUp.defaultPrevented).toBe(false);
    expect(controller.getState().log.length).toBe(1);
    const f5 = press(container, 'F5');
    expect(f5.defaultPrevented).toBe(false);
  });
});

describe('typing', () => {
  it('one printable key = exactly one typeToken op; a consecutive typing run COALESCES into one log entry (U1, session 5)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();

    press(container, '5');
    expect(controller.getState().log.length).toBe(1);
    expect(controller.getState().log[0].ops.length).toBe(1);
    expect(j(controller.getEnvelope().root)).toBe(j(num(5)));
    // 4a re-pin (OA-token-end): the typed 5's in-token end
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: [], index: 1 }));

    press(container, '+');
    // U1/S-080: `+` is a typing-class key after a typing action — same unit
    expect(controller.getState().log.length).toBe(1);
    expect(controller.getState().log[0].ops.length).toBe(2);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [num(5), null] }));
    expect(j(controller.getState().caret)).toBe(j(row([], 1)));

    press(container, '3');
    expect(controller.getState().log.length).toBe(1); // still the one open run
    expect(controller.getState().log[0].ops.length).toBe(3);
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
    // 4a: seed at the in-token end (the old node caret painted the same spot)
    controller.placeCaret({ kind: 'token', path: ['num'], index: 1 });
    container.focus();

    const down = press(container, 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    // 4a re-pin (OA-vertical-default): the arrival rests at the region content
    // END (the in-token end), never ON the content node
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den'], index: 1 }));
    expect(controller.getState().log.length).toBe(0);

    press(container, 'ArrowUp');
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num'], index: 1 }));
    expect(controller.getState().log.length).toBe(0);

    // 4a: up past the top is the same-state no-op; <- from the content start
    // N1-steps out to the fraction's before-station (S-095's mirror at the
    // lone root — the ruling keeps the before-station and the content start
    // distinct positions), and a further <- is N3's no-op
    const before = controller.getState();
    press(container, 'ArrowUp'); // up from the numerator: document edge
    expect(controller.getState()).toBe(before);
    press(container, 'ArrowLeft'); // N1: char-step to the content start
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num'], index: 0 }));
    press(container, 'ArrowLeft'); // S-095-mirror: steps out to the before-station
    expect(j(controller.getState().caret)).toBe(j({ kind: 'node', path: [], side: 'left' }));
    const atBorder = controller.getState();
    press(container, 'ArrowLeft'); // N3 at the formula start: no-op
    expect(controller.getState()).toBe(atBorder);
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
    // 4a re-pin (OA-vertical-default): the den row's content END — d's end
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den', 1], index: 1 }));
    expect(controller.getVerticalMemory().size).toBe(1); // the num region stored the origin
    press(container, 'ArrowLeft'); // N1: to d's start
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den', 1], index: 0 }));
    press(container, 'ArrowLeft'); // crosses the glyph to c's end (N1's exit rule)
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den', 0], index: 1 }));
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
    // 4a re-pin: the stored spot is c's in-token END (the position on leaving, with 4a benches)
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den', 0], index: 1 }));
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
    // 4a re-pin (OA-vertical-default): the inner den's content end (b's end)
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num', 'den'], index: 1 }));
    press(container, 'ArrowUp'); // arrives inner-num region → its store fires
    expect(j(controller.getState().caret)).toBe(j(start));
    press(container, 'ArrowDown'); // again into the inner den
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num', 'den'], index: 1 }));
    press(container, 'ArrowDown'); // inner den → outer den (stores inner-den)
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den'], index: 1 }));
    press(container, 'ArrowUp'); // outer num region has no store yet → structural; stores outer-den
    // 4a: "rest at the end of the frac" — the bare inner frac's content end
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num', 'den'], index: 1 }));
    press(container, 'ArrowDown'); // arrives outer-den region → its store fires
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den'], index: 1 }));
    press(container, 'ArrowUp'); // arrives outer-num region → stored on the way down → fires
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['num', 'den'], index: 1 }));
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
    // 4a re-pin (OA-vertical-default): the den row's content end (y's end)
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: ['den', 1], index: 1 }));
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
    // 4a re-pin (OA-vertical-default): the num content end
    expect(j(res.caret)).toBe(j({ kind: 'token', path: ['num'], index: 1 }));
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
    // U1 re-pin (session 5, S-080): the `5`,`+` typing run is ONE unit
    expect(controller.getState().log.length).toBe(1);
    expect(controller.getState().log[0].ops.length).toBe(2);
    const before = j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length]);

    const z = press(container, 'z', { ctrl: true });
    expect(z.defaultPrevented).toBe(true);
    expect(controller.getState().log.length).toBe(0); // the whole run unwinds in one undo
    expect(j(controller.getEnvelope().root)).toBe('null');
    expect(j(controller.getState().caret)).toBe(j({ kind: 'empty' }));
    expect(controller.getState().redo.length).toBe(1);
    expect(controller.getState().redo[0].ops.length).toBe(2);

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
    // U1 re-pin (session 5): one coalesced run unit
    expect(controller.getState().log.length).toBe(1);
    const before = j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length]);
    press(container, 'z', { ctrl: true });
    expect(controller.getState().log.length).toBe(0);
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

// ——— T8: dead keys (rework session 2b-1) ———
// On dead-key layouts (German/Austrian QWERTZ) the `^` press gives no live
// feedback; the power materializes with the NEXT key press (S-034/S-035 B).
// The pending fires ONLY for the `^` key position, identified via event.code
// (mechanical ruling); it is controller-side, transient, never serialized and
// never logged, and one-shot (owner ruling 2026-11-09): it survives until the
// very next key press of any kind — a typing key resolves it, everything else
// (Backspace, arrows, Home/End, click, blur, any non-printable) discards it and
// does its ordinary job.

describe('T8 — dead-key pending for the `^` position', () => {
  const classify = (key: string, opts: KeyOpts = {}) =>
    classifyKey({ key, code: opts.code, ctrlKey: !!opts.ctrl, metaKey: !!opts.meta, altKey: !!opts.alt, shiftKey: !!opts.shift });

  it('classification: key=Dead arms the pending — ANY dead key, any position (owner directive 2026-11-09)', () => {
    // The positional event.code identification was overruled in the live
    // check: layouts disagree about where (and shift-state) the dead ^ lives
    // (the owner's own layout has it UNSHIFTED at Backquote). Every Dead
    // press now arms the pending.
    expect(classify('Dead', { shift: false, code: 'Backquote' })).toEqual({ kind: 'deadPow' });
    expect(classify('Dead', { shift: true, code: 'Backquote' })).toEqual({ kind: 'deadPow' });
    expect(classify('Dead', { shift: true, code: 'BracketLeft' })).toEqual({ kind: 'deadPow' });
    expect(classify('Dead', { code: 'Quote' })).toEqual({ kind: 'deadPow' });
    expect(classify('Dead', {})).toEqual({ kind: 'deadPow' }); // no code at all
    // a non-dead layout keeps the live path: the printed ^ types directly
    expect(classify('^', { code: 'Digit6' })).toEqual({ kind: 'type', token: { t: 'pow' } });
  });

  it('a Dead ^ press: pending, preventDefaulted (OS composition suppressed), state byte-identical, nothing logged', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    const before = controller.getState();
    const ev = press(container, 'Dead', { shift: true, code: 'Backquote' });
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before); // the exact state object — no trace
    expect(controller.getEnvelope()).toEqual({ v: 1, root: sym('a') });
  });

  it('the next character materializes the power with the character in the exponent (S-034)', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    press(container, '2');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
    // 4a re-pin (OA-token-end): the typed 2's in-token end
    expect(controller.getState().caret).toEqual({ kind: 'token', path: ['exp'], index: 1 });
    // two ops for two keys — undo parity with a live layout's `^` then `2`;
    // undo walks the character, then the power
    expect(controller.getState().log.length).toBe(2);
    controller.undo();
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null }));
    controller.undo();
    expect(j(controller.getEnvelope().root)).toBe(j(sym('a')));
  });

  it('a dead key on another position (e.g. a shifted one) arms too: Dead + `2` (live-check flow, 2026-11-09)', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'BracketLeft' });
    press(container, '2');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
  });

  it('Firefox/Windows `Process` keystrokes resolve the pending: the physical code supplies the character (2026-11-09 live-check bug)', () => {
    // Firefox on Windows: the composed second keystroke reports key='Process'
    // (no character identity) — without the code fallback the digit was lost
    // and no power ever materialized.
    const digit = make({ v: 1, root: sym('a') });
    digit.container.focus();
    press(digit.container, 'Dead', { shift: true, code: 'BracketLeft' });
    press(digit.container, 'Process', { code: 'Digit2' });
    expect(j(digit.controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
    // a letter arrives the same way
    const letter = make({ v: 1, root: sym('a') });
    letter.container.focus();
    press(letter.container, 'Dead', { shift: true, code: 'Backquote' });
    press(letter.container, 'Process', { code: 'KeyN' });
    expect(j(letter.controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: sym('n') }));
    // an unmappable code (e.g. Space completing the composition): the power
    // materializes with the empty □ exponent — the composed char is retyped
    const bare = make({ v: 1, root: sym('a') });
    bare.container.focus();
    press(bare.container, 'Dead', { shift: true, code: 'Backquote' });
    press(bare.container, 'Process', { code: 'Space' });
    expect(j(bare.controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null }));
  });

  it('Firefox composition path (2026-11-09 live check): the composed character arrives via compositionend and resolves the pending', () => {
    // normalized composition forms → the base character lands in the exponent
    const compose = (data: string): { controller: EditorController } => {
      const { controller, container } = make({ v: 1, root: sym('a') });
      container.focus();
      press(container, 'Dead', { code: 'Backquote' });
      container.dispatchEvent(new CompositionEvent('compositionend', { data }));
      return { controller };
    };
    expect(j(compose('2\u0302').controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) })); // decomposed digit
    expect(j(compose('^2').controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) })); // spacing-circumflex prefix (non-composable emission)
    expect(j(compose('e\u0302').controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: sym('e') })); // decomposed letter
    expect(j(compose('^').controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null })); // dead-^ + SPACE (S-035 B)
    expect(j(compose('').controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null })); // unrecoverable data: at least the empty power
  });

  it('the keyup last resort resolves a pending that keydown/compositionend never delivered', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { code: 'Backquote' });
    container.dispatchEvent(new KeyboardEvent('keyup', { key: '2', bubbles: true }));
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
    // a second resolution attempt (however it arrives) never double-fires
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '^' }));
    expect(controller.getState().log.length).toBe(2); // the pow op + the digit — one power total
    // without a pending, keyup resolves nothing
    const plain = make({ v: 1, root: sym('a') });
    plain.container.focus();
    plain.container.dispatchEvent(new KeyboardEvent('keyup', { key: '5', bubbles: true }));
    expect(j(plain.controller.getEnvelope().root)).toBe(j(sym('a')));
  });

  it('the empty-formula dead-^ flow: `1` lands in the exponent of pow(□, 1)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    press(container, '1');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: null, exp: num(1) }));
    expect(controller.getState().log.length).toBe(2); // the deferred ^ op + the digit
  });

  it('SPACE resolves the pending to the empty □ exponent (S-035 B); the OS-emitted literal ^ is swallowed as intent', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    press(container, ' ');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null }));
    expect(controller.getState().caret).toEqual({ kind: 'slot', path: [], slot: 'exp' });
    expect(controller.getState().log.length).toBe(1); // the space re-dispatch no-ops in the exponent void
    // the platform that emits the literal `^` after the dead press instead:
    const other = make({ v: 1, root: sym('a') });
    other.container.focus();
    press(other.container, 'Dead', { shift: true, code: 'Backquote' });
    press(other.container, '^', { code: 'Backquote' });
    expect(j(other.controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: null }));
    expect(other.controller.getState().log.length).toBe(1); // one power only — the literal was the intent
  });

  it('a dead-^ re-press re-arms (idempotent): still nothing until the next key, then ONE power (owner ruling)', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    const mid = controller.getState();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    expect(controller.getState()).toBe(mid);
    press(container, '2');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
    expect(controller.getState().log.length).toBe(2);
  });

  it('one-shot (owner ruling 2026-11-09): Backspace discards the pending and does its ordinary job — no power ever', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    press(container, 'Backspace');
    expect(controller.getEnvelope().root).toBe(null); // the whole symbol deleted — as if ^ had never been pressed
  });

  it('one-shot: an arrow discards the pending; the following character types ordinarily (no power)', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    press(container, 'ArrowLeft');
    press(container, 'b');
    // no power — the pending was discarded. N1: ← at the in-token end steps
    // to the symbol's start (the lone root has no beyond), and `b` glues AT
    // offset 0 (T3) — prepending: the ordinary no-power behavior.
    expect(j(controller.getEnvelope().root)).toBe(j(sym('ba')));
  });

  it('one-shot: pure caret placement (the click path) discards the pending', () => {
    const { controller, container } = make({ v: 1, root: sym('a') });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    controller.placeCaret({ kind: 'token', path: [], index: 0 });
    press(container, 'b');
    expect(j(controller.getEnvelope().root)).toBe(j(sym('ba')));
  });

  it('one-shot: blur discards the pending with no trace', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, 'Dead', { shift: true, code: 'Backquote' });
    container.dispatchEvent(new Event('blur'));
    press(container, '1');
    expect(j(controller.getEnvelope().root)).toBe(j(num(1))); // an ordinary lone number — no power
  });

  it('every dead key arms the pending (owner directive 2026-11-09): the character lands in the exponent', () => {
    // Any Dead press — position, shift state, code presence all irrelevant.
    // The character resolves the pending; composition remnants never reach
    // the formula.
    for (const opts of [{ code: 'Quote' }, { shift: false, code: 'Backquote' }, {}] as KeyOpts[]) {
      const { controller, container } = make({ v: 1, root: sym('a') });
      container.focus();
      press(container, 'Dead', opts);
      press(container, '2');
      expect(j(controller.getEnvelope().root)).toBe(j({ type: 'pow', base: sym('a'), exp: num(2) }));
    }
  });
});
