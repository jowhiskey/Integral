// @vitest-environment jsdom
// Undo-exhaustion signal (EditorControllerOptions.onUndoExhausted): fires
// exactly when an undo takes the internal op log from non-empty to empty —
// the moment the editor has nothing left of its own to walk back. Pinned
// edges: not at mount with an already-empty stack, not on an empty-log
// no-op undo, not on a non-emptying undo, not on reset (a reseed clears the
// log without undoing), re-fires after a redo/undo cycle re-empties it, and
// the keyboard Ctrl+Z path flows through the same undo().

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import type { NodeJson } from '../src/ast/json.js';
import type { Op } from '../src/engine/index.js';
import { EditorController, type EditorControllerOptions } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const SEED_A = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };

/** One insert at the root row's end — one undo unit per controller.apply. */
const rowEnd = (node: NodeJson): Op => ({ op: 'insert', node, at: { at: 'row', path: [], index: 2 } });

function make(options: Omit<EditorControllerOptions, 'envelope'> = {}): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  stubRects({ container: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope: SEED_A, ...options });
  return { controller, container };
}

function press(container: HTMLElement, key: string, opts: { ctrl?: boolean; code?: string } = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    code: opts.code,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!opts.ctrl,
  });
  container.dispatchEvent(ev);
  return ev;
}

describe('onUndoExhausted: the emptying edge', () => {
  it('fires exactly once on the undo that empties the log', () => {
    const onUndoExhausted = vi.fn();
    const { controller } = make({ onUndoExhausted });
    controller.apply(rowEnd(num(7))); // one unit: log 1
    expect(controller.getState().log.length).toBe(1);
    controller.undo(); // 1 -> 0: the emptying undo
    expect(controller.getState().log.length).toBe(0);
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
  });

  it('does not fire at mount with an already-empty stack', () => {
    const onUndoExhausted = vi.fn();
    make({ onUndoExhausted });
    expect(onUndoExhausted).not.toHaveBeenCalled();
  });

  it('does not fire on an empty-log no-op undo', () => {
    const onUndoExhausted = vi.fn();
    const { controller } = make({ onUndoExhausted });
    controller.undo(); // defined no-op on the empty log
    controller.undo();
    expect(controller.getState().log.length).toBe(0);
    expect(onUndoExhausted).not.toHaveBeenCalled();
  });

  it('does not fire on a non-emptying undo — only the emptying step signals', () => {
    const onUndoExhausted = vi.fn();
    const { controller } = make({ onUndoExhausted });
    controller.apply(rowEnd(num(7))); // unit 1 (apply is a non-typing action: its own unit)
    controller.apply(rowEnd(num(8))); // unit 2
    expect(controller.getState().log.length).toBe(2);
    controller.undo(); // 2 -> 1: the editor still has its own history — no signal
    expect(onUndoExhausted).not.toHaveBeenCalled();
    controller.undo(); // 1 -> 0: emptying
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
  });

  it('re-fires after a redo/undo cycle re-empties the log (and redo itself fires nothing)', () => {
    const onUndoExhausted = vi.fn();
    const { controller } = make({ onUndoExhausted });
    controller.apply(rowEnd(num(7)));
    controller.undo(); // empties — fire #1
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
    controller.redo(); // log back to 1 — no signal on redo
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
    expect(controller.getState().log.length).toBe(1);
    controller.undo(); // re-empties — fire #2
    expect(onUndoExhausted).toHaveBeenCalledTimes(2);
  });

  it('does not fire on reset (a reseed clears the log without an undo)', () => {
    const onUndoExhausted = vi.fn();
    const { controller } = make({ onUndoExhausted });
    controller.apply(rowEnd(num(7)));
    expect(controller.getState().log.length).toBe(1);
    controller.reset({ v: 1, root: null });
    expect(controller.getState().log.length).toBe(0);
    expect(onUndoExhausted).not.toHaveBeenCalled();
  });

  it('fires through the keyboard path too (focused Ctrl+Z), and not on the guarded empty-log Ctrl+Z', () => {
    const onUndoExhausted = vi.fn();
    const { controller, container } = make({ onUndoExhausted });
    container.focus();
    press(container, '5'); // one typing unit: log 1
    expect(controller.getState().log.length).toBe(1);
    press(container, 'z', { ctrl: true }); // Ctrl+Z -> undo() -> 1 -> 0
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
    expect(controller.getState().log.length).toBe(0);
    press(container, 'z', { ctrl: true }); // empty log: the handler guards — no undo, no signal
    expect(onUndoExhausted).toHaveBeenCalledTimes(1);
  });

  it('fires after the commit — the callback observes the post-undo state (empty log)', () => {
    let controller: EditorController;
    let logLenAtFire = -1;
    let envelopeAtFire = '';
    ({ controller } = make({
      onUndoExhausted: () => {
        logLenAtFire = controller.getState().log.length;
        envelopeAtFire = JSON.stringify(controller.getEnvelope());
      },
    }));
    controller.apply(rowEnd(num(7)));
    controller.undo();
    expect(logLenAtFire).toBe(0);
    expect(envelopeAtFire).toBe(JSON.stringify({ v: 1, root: SEED_A.root })); // the pre-insert content
  });
});
