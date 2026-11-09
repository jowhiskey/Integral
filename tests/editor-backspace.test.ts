// @vitest-environment jsdom
// Backspace/Delete wiring (rework session 3): classifyKey gains Delete +
// Ctrl+Delete; the controller drives the engine decisions (one key = at most
// one op = at most one log entry); the D5 highlight is a TRANSIENT controller
// state (the structure element painted red, never an undo-log entry — U2);
// any input that is not the confirming BS clears it; the Firefox/Windows
// dead-key rider (Dead → the two-char key value "^2") resolves the pending
// power (the owner live reading, pinned per the session rider).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { toJSON } from '../src/ast/serialize.js';
import { initSession, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';
import { classifyKey, deadComposedBase } from '../src/editor/keys.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value });
const sym = (name: string) => ({ type: 'sym', name });
const op = (name: string, ...args: (unknown | null)[]) => ({ type: 'op', op: name, args });
const frac = (n: unknown, d: unknown) => ({ type: 'frac', num: n, den: d });
const node = (path: readonly (number | string)[]): Caret => ({ kind: 'node', path });
const slot = (path: readonly (number | string)[], s: string): Caret => ({ kind: 'slot', path, slot: s as never });
const rowc = (path: readonly (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
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
  code?: string;
  isComposing?: boolean;
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
  Object.defineProperty(ev, 'code', { value: opts.code }); // jsdom does not model layouts
  Object.defineProperty(ev, 'isComposing', { value: !!opts.isComposing });
  container.dispatchEvent(ev);
  return ev;
}

describe('classifyKey: Backspace/Delete + the Ctrl variants (D3)', () => {
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
    expect(classifyKey(ev('Delete'))).toEqual({ kind: 'delete', ctrl: false }); // rework session 3: the forward mirror
    expect(classifyKey(ev('Delete', { ctrl: true }))).toEqual({ kind: 'delete', ctrl: true });
    expect(classifyKey(ev('Delete', { alt: true }))).toEqual({ kind: 'ignore' }); // alt passes through
    expect(classifyKey(ev('Enter'))).toEqual({ kind: 'ignore' }); // K2 stays session-5 scope
  });
});

describe('the dead-key rider: deadComposedBase (the Firefox/Windows two-character emission)', () => {
  it('extracts the composed base character from a two-char key value; F-keys stay null', () => {
    expect(deadComposedBase('^2')).toBe('2');
    expect(deadComposedBase('^q')).toBe('q');
    expect(deadComposedBase('F1')).toBe(null); // not a composition
    expect(deadComposedBase('Backspace')).toBe(null);
    expect(deadComposedBase('^')).toBe(null); // a bare accent is not the two-char emission
  });
});

describe('the Firefox/Windows dead-key sequence through the controller (the session rider pin)', () => {
  it('keydown key="Dead" then keydown key="^2" (isComposing=false) → the power materializes with 2 in the exponent — no composition events at all', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, 'Dead');
    // the follow-up keydown carries the composed output as a two-character key
    // value — NO composition events fire at all on Firefox/Windows
    const ev = press(container, '^2', { code: 'Digit2' });
    expect(ev.defaultPrevented).toBe(true);
    // the power materializes and the composed character lands in the exponent (S-034)
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'pow', base: null, exp: { type: 'num', value: 2 } }),
    );
    expect(j(controller.getState().caret)).toBe(j(node(['exp'])));
    // two ops: the deferred pow creation + the character — undo parity with a
    // live layout (the ^ then the 2)
    expect(controller.getState().log.length).toBe(2);
  });
});

describe('the ruled chains through the keyboard', () => {
  const FRAC = {
    v: 1,
    root: {
      type: 'op',
      op: 'add',
      args: [
        sym('x'),
        { type: 'frac', num: num(12), den: num(3) },
      ],
    },
  };

  it('the in-slot rundown: 12 → 1 → the pending null, then the D6 unwrap keeps the den (rework session 3 re-pin of the falsified guard model)', () => {
    const { controller, container } = make(FRAC);
    controller.placeCaret(node([1, 'num']));
    container.focus();
    press(container, 'Backspace'); // 12 → 1 (D1 char-wise)
    expect(j(controller.getEnvelope())).toContain('"value":1');
    expect(controller.getState().log.length).toBe(1);
    press(container, 'Backspace'); // 1 dies → the num slot □ (D1)
    expect(j(controller.getEnvelope())).toContain('"num":null');
    expect(j(controller.getState().caret)).toBe(j(slot([1], 'num')));
    press(container, 'Backspace'); // D6: the □ unwraps — the den promotes inline
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', sym('x'), num(3))));
    expect(j(controller.getState().caret)).toBe(j(rowc([], 1))); // x + |3
    expect(controller.getState().log.length).toBe(3);
  });

  it('Ctrl+BS in-token takes the left RUN (text[2..) survives — the whole token only at offset = length); Del then mirrors forward (D3 both directions)', () => {
    const env = { v: 1, root: op('add', num(123), sym('b')) };
    const { controller, container } = make(env);
    controller.placeCaret({ kind: 'token', path: [0], index: 2 });
    container.focus();
    press(container, 'Backspace', { ctrl: true }); // 123 at offset 2 → the 3 survives, everything left dies
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', num(3), sym('b'))));
    expect(j(controller.getState().caret)).toBe(j({ kind: 'token', path: [0], index: 0 }));
    expect(controller.getState().log.length).toBe(1);
    // Ctrl at the RIGHT edge (= length) takes the whole token: the 3 dies,
    // the freed cell is the pending null — the glyphs never splice away (D1)
    controller.placeCaret({ kind: 'token', path: [0], index: 1 });
    press(container, 'Backspace', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', null, sym('b'))));
    expect(j(controller.getState().caret)).toBe(j(rowc([], 0)));
    expect(controller.getState().log.length).toBe(2);
  });

  it('Delete + Ctrl+Delete act forward at gaps (x + |abc → x + bc; the Ctrl mirror takes the whole token)', () => {
    const env = { v: 1, root: op('add', sym('x'), sym('abc')) };
    const { controller, container } = make(env);
    controller.placeCaret(rowc([], 1));
    container.focus();
    press(container, 'Delete');
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', sym('x'), sym('bc'))));
    expect(j(controller.getState().caret)).toBe(j(rowc([], 1)));
    press(container, 'Delete', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', sym('x'), null)));
    expect(controller.getState().log.length).toBe(2);
  });

  it('both keys are silent no-ops on the empty formula (S-078)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const before = controller.getState();
    const bs = press(container, 'Backspace');
    expect(bs.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before);
    const del = press(container, 'Delete');
    expect(del.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before);
  });

  it("B-23 through the keyboard: the empty-argument chain sin(x,y) → sin(x,|) → sin(x|) → sin(|□) → the fn dies; NO placeholder renders beyond the first argument", () => {
    const env = { v: 1, root: { type: 'fn', name: 'sin', args: [sym('x'), sym('y')] } };
    const { controller, container } = make(env);
    controller.placeCaret(rowc([], 2));
    container.focus();
    press(container, 'Backspace'); // y — the freed seat renders BARE (no □)
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'fn', name: 'sin', args: [sym('x'), null] }));
    expect(controller.getRendered()!.placeholders.size).toBe(0); // the □ lives on the FIRST argument only
    press(container, 'Backspace'); // the emptied second argument collapses WITH its comma
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'fn', name: 'sin', args: [sym('x')] }));
    press(container, 'Backspace'); // x
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'fn', name: 'sin', args: [null] }));
    press(container, 'Backspace'); // sin(|□) — the whole function dies
    expect(j(controller.getEnvelope().root)).toBe('null');
    expect(controller.getState().caret).toEqual({ kind: 'empty' });
    expect(controller.getState().log.length).toBe(4);
  });

  it("B-18 through the keyboard: BS at the EMPTY radicand of a root in an args row kills ONLY the root — the + keeps dangling", () => {
    const env = { v: 1, root: op('add', sym('x'), { type: 'root', radicand: null }) };
    const { controller, container } = make(env);
    controller.placeCaret(slot([1], 'radicand'));
    container.focus();
    press(container, 'Backspace');
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', sym('x'), null))); // x + |
    expect(j(controller.getState().caret)).toBe(j(rowc([], 1)));
    expect(controller.getState().log.length).toBe(1);
  });
});

describe('D5 highlight-then-delete through the keyboard (transient, never logged)', () => {
  const SEED = {
    v: 1,
    root: op('add', sym('x'), frac(num(1), num(2))),
  };

  const structureEl = (controller: EditorController, path: readonly (number | string)[]): Element | null =>
    controller.getRendered()?.elementByPath.get(JSON.stringify(path)) ?? null;

  it('the first BS paints the structure red (a transient controller state, NO log growth, NO tree change); the confirming BS deletes WITH its content, leaving the plus dangling', () => {
    const { controller, container } = make(SEED);
    controller.placeCaret(rowc([], 2));
    container.focus();
    const before = controller.getState();
    const ev1 = press(container, 'Backspace');
    expect(ev1.defaultPrevented).toBe(true);
    expect(controller.getState()).toBe(before); // nothing applied
    expect(controller.getState().log.length).toBe(0); // U2: the highlight NEVER logs
    const el = structureEl(controller, [1]);
    expect(el).not.toBeNull();
    expect(el!.classList.contains('integral-highlight')).toBe(true); // the red paint
    const ev2 = press(container, 'Backspace');
    expect(ev2.defaultPrevented).toBe(true);
    expect(j(controller.getEnvelope().root)).toBe(j(op('add', sym('x'), null))); // B-14: the + dangles
    expect(j(controller.getState().caret)).toBe(j(rowc([], 1)));
    expect(controller.getState().log.length).toBe(1); // the DELETE is the unit (one undo restores the whole structure)
    // undo restores the whole structure with its content AND the caret (U2)
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(SEED.root));
    expect(j(controller.getState().caret)).toBe(j(rowc([], 2)));
  });

  it('any input that is not the confirming BS clears the highlight and behaves as if it never happened (the ruled lifecycle judgment)', () => {
    const { controller, container } = make(SEED);
    controller.placeCaret(rowc([], 2));
    container.focus();
    press(container, 'Backspace'); // highlight armed + painted
    expect(structureEl(controller, [1])!.classList.contains('integral-highlight')).toBe(true);
    // a typed key clears the negotiation and types normally
    press(container, 'y'); // the gap: juxtaposes a pair onto the frac — tree changes either way
    expect(controller.getState().log.length).toBe(1); // the typing key applied; the highlight never did
    expect(structureEl(controller, [1])!.classList.contains('integral-highlight')).toBe(false);
  });

  it('a caret move clears the paint without logging (the highlight is never a log unit)', () => {
    const { controller, container } = make(SEED);
    controller.placeCaret(rowc([], 2));
    container.focus();
    press(container, 'Backspace');
    expect(structureEl(controller, [1])!.classList.contains('integral-highlight')).toBe(true);
    press(container, 'ArrowLeft');
    expect(controller.getState().log.length).toBe(0);
    expect(structureEl(controller, [1])!.classList.contains('integral-highlight')).toBe(false);
  });

  it('BS at a DIFFERENT station after an arm highlights the new decision (the confirm never fires cross-station)', () => {
    const { controller, container } = make(SEED);
    controller.placeCaret(rowc([], 2));
    container.focus();
    press(container, 'Backspace'); // arm frac at [1]
    controller.placeCaret(node([0])); // a click-away placement: the placement clears the arm
    press(container, 'Backspace');
    // the arm is gone; BS deletes x itself (D1: the emptied token leaves the pending null cell)
    expect(j(controller.getEnvelope().root)).toBe(
      j(op('add', null, frac(num(1), num(2)))),
    );
    expect(controller.getState().log.length).toBe(1);
  });
});

// sanity: the fixture envelopes round-trip
it('fixture envelopes are legal', () => {
  expect(toJSON(initSession({ v: 1, root: frac(num(12), num(3)) }).root).root).toEqual({
    type: 'frac',
    num: num(12),
    den: num(3),
  });
});
