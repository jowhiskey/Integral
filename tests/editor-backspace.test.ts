// @vitest-environment jsdom
// Backspace wiring (DOM-layer session 3): classifyKey gains Backspace and
// Ctrl/Meta+Backspace (handled = preventDefault while focused, ignored
// unfocused), and the controller drives the engine's backspace decision — one
// key = at most one op = at most one log entry; defined no-ops change nothing
// and never throw; undo steps the peel back byte-exactly.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { toJSON } from '../src/ast/serialize.js';
import { initSession, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';
import { classifyKey } from '../src/editor/keys.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const slot = (path: readonly (number | string)[], s: string): Caret => ({ kind: 'slot', path, slot: s as never });
const j = (x: unknown): string => JSON.stringify(x);

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'bs';
  document.body.appendChild(container);
  stubRects({ bs: { left: 0, top: 0, width: 300, height: 40 } });
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
    altKey: !!opts.alt,
    shiftKey: !!opts.shift,
  });
  container.dispatchEvent(ev);
  return ev;
}

describe('classifyKey: Backspace + Ctrl/Meta+Backspace', () => {
  const ev = (key: string, mods: KeyOpts = {}) => ({
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });
  it('pins the classification', () => {
    expect(classifyKey(ev('Backspace'))).toEqual({ kind: 'backspace', ctrl: false });
    expect(classifyKey(ev('Backspace', { ctrl: true }))).toEqual({ kind: 'backspace', ctrl: true });
    expect(classifyKey(ev('Backspace', { meta: true }))).toEqual({ kind: 'backspace', ctrl: true });
    expect(classifyKey(ev('Backspace', { ctrl: true, shift: true }))).toEqual({ kind: 'backspace', ctrl: true });
    expect(classifyKey(ev('Delete'))).toEqual({ kind: 'ignore' }); // forward Delete stays out of scope
    expect(classifyKey(ev('Backspace', { alt: true }))).toEqual({ kind: 'ignore' }); // alt passes through
  });
});

describe('focus gate + preventDefault for Backspace', () => {
  it('ignored while unfocused; handled (preventDefault) while focused — even for defined no-ops', () => {
    const { controller, container } = make({ v: 1, root: null });
    const before = controller.getState();
    const unfocused = press(container, 'Backspace');
    expect(unfocused.defaultPrevented).toBe(false);
    expect(controller.getState()).toBe(before);

    container.focus();
    const ev = press(container, 'Backspace'); // empty formula: a defined no-op
    expect(ev.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before); // same state object, no log growth, no throw
    expect(controller.getState().log.length).toBe(0);
  });
});

describe('backspace through the keyboard: the peel on a fraction', () => {
  const FRAC = { v: 1, root: { type: 'frac', num: num(12), den: num(3) } };

  it('Backspace peels digits, then the emptied number → placeholder, then (den has content) no-op; Ctrl+Backspace deletes whole nodes', () => {
    const { controller, container } = make(FRAC);
    controller.placeCaret(node(['num']));
    container.focus();

    let ev = press(container, 'Backspace'); // 12 → 1
    expect(ev.defaultPrevented).toBe(true);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: num(1), den: num(3) }));
    expect(controller.getState().log.length).toBe(1);

    press(container, 'Backspace'); // 1 → emptied → num □, caret in the placeholder
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: null, den: num(3) }));
    expect(j(controller.getState().caret)).toBe(j(slot([], 'num')));
    expect(controller.getState().log.length).toBe(2);

    const atPlaceholder = controller.getState();
    press(container, 'Backspace'); // den still has content → defined no-op
    expect(controller.getState()).toBe(atPlaceholder);
    expect(controller.getState().log.length).toBe(2);

    // Ctrl+Backspace on the den: whole node under the same guard → den □ (two placeholders, frac stays)
    controller.placeCaret(node(['den']));
    press(container, 'Backspace', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: null, den: null }));
    expect(j(controller.getState().caret)).toBe(j(slot([], 'den')));
    expect(controller.getState().log.length).toBe(3);

    // structure death: backspace AT a placeholder with every region empty → the whole frac dies
    press(container, 'Backspace');
    expect(j(controller.getEnvelope().root)).toBe('null');
    expect(j(controller.getState().caret)).toBe(j({ kind: 'empty' }));
    expect(controller.getState().log.length).toBe(4);
  });

  it('undo walks the whole peel chain back byte-exactly (tree + caret + log)', () => {
    const { controller, container } = make(FRAC);
    controller.placeCaret(node(['num']));
    container.focus();
    press(container, 'Backspace'); // 12 → 1
    press(container, 'Backspace'); // → □
    const mid = j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length]);
    press(container, 'z', { ctrl: true });
    expect(j([controller.getEnvelope(), controller.getState().caret, controller.getState().log.length])).not.toBe(mid);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: num(1), den: num(3) }));
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(FRAC.root));
    expect(j(controller.getState().caret)).toBe(j(node(['num'])));
    expect(controller.getState().log.length).toBe(0);
  });

  it('Ctrl+Backspace at an in-token caret deletes the whole number; plain Backspace peels one digit', () => {
    const env = { v: 1, root: { type: 'op', op: 'add', args: [num(123), sym('b')] } };
    const { controller, container } = make(env);
    const tok: Caret = { kind: 'token', path: [0], index: 2 };
    controller.placeCaret(tok);
    container.focus();
    press(container, 'Backspace'); // peel '2' → 13, caret keeps offset 2
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [num(13), sym('b')] }));
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: [0], index: 2 }));
    expect(controller.getState().log.length).toBe(1);
    press(container, 'Backspace', { ctrl: true }); // whole number
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [sym('b')] }));
    expect(j(controller.getState().caret)).toBe(j({ kind: 'row', path: [], index: 0 }));
    expect(controller.getState().log.length).toBe(2);
  });
});

describe('backspace no-op cases through the keyboard (never throw, never log)', () => {
  it('row seam 0 and a seam with an empty cell to its left are defined no-ops', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null] } });
    container.focus();
    controller.placeCaret({ kind: 'row', path: [], index: 0 });
    let before = controller.getState();
    press(container, 'Backspace');
    expect(controller.getState()).toBe(before);
    controller.placeCaret({ kind: 'row', path: [], index: 2 }); // empty cell left of the seam
    before = controller.getState();
    press(container, 'Backspace');
    expect(controller.getState()).toBe(before);
    expect(controller.getState().log.length).toBe(0);
  });
});

// sanity: the fixture envelopes round-trip
it('fixture envelopes are legal', () => {
  expect(toJSON(initSession({ v: 1, root: { type: 'frac', num: num(12), den: num(3) } }).root).root).toEqual({
    type: 'frac',
    num: num(12),
    den: num(3),
  });
});
