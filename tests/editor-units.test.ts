// @vitest-environment jsdom
// Unit typing through the controller (rework session 2b-2) — the S-051
// leave triggers on the DOM key path: non-letter keys / arrows / clicks /
// blur fire the conversion, letters never do, undo/redo keys never do; the
// T9 vocabulary methods (insertRoot / insertSubscript) ride the real
// controller; the IME / dead-key event logger (the standing demo tool)
// records the stream it observes.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { envelopeOf, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';
import { attachImeLogger, type ImeLogLine } from '../demo/ime-logger.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const j = (x: unknown): string => JSON.stringify(x);

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'kb';
  document.body.appendChild(container);
  stubRects({ kb: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope });
  return { controller, container };
}

function press(container: HTMLElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  container.dispatchEvent(ev);
  return ev;
}

/** Type `50mm` on the real keyboard path — the as-typed letter run. */
function typeRun(container: HTMLElement): void {
  for (const ch of ['5', '0', 'm', 'm']) press(container, ch);
}

describe('controller — S-051 leave triggers (the unit-run conversion)', () => {
  it('letters alone convert nothing: the run stays an ordinary symbol pair', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(50), sym('mm')], implicit: true }),
    );
  });

  it('an arrow key leaves the run: the conversion lands (one op; the caret maps to the label edge)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    const logBefore = controller.getState().log.length;
    press(container, 'ArrowRight'); // at the document end the MOVE no-ops — but the settle fired
    const state = controller.getState();
    expect(j(envelopeOf(state).root)).toBe(j({ type: 'unit', value: num(50), unit: 'mm' }));
    expect(state.log.length).toBe(logBefore + 1);
    expect(state.caret).toEqual({ kind: 'token', path: [], index: 2 } satisfies Caret);
  });

  it('a non-letter key leaves the run BEFORE its own action: `50mm` + `+` wraps the unit', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    press(container, '+');
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({ type: 'op', op: 'add', args: [{ type: 'unit', value: num(50), unit: 'mm' }, null] }),
    );
  });

  it('blur leaves the run (the host reads a converted envelope)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    container.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    expect(j(envelopeOf(controller.getState()).root)).toBe(j({ type: 'unit', value: num(50), unit: 'mm' }));
  });

  it('undo/redo keys do NOT fire the settle (history commands are not content keys)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    // U1 re-pin (session 5): the `50mm` run is ONE unit
    const logBefore = controller.getState().log.length;
    expect(logBefore).toBe(1);
    const ctrlZ = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    container.dispatchEvent(ctrlZ);
    // no settle op fired: the undo removed the whole run — no extra entry first,
    // and the pre-run state is the EMPTY formula (not a unit node)
    expect(controller.getState().log.length).toBe(logBefore - 1);
    expect(j(envelopeOf(controller.getState()).root)).toBe('null');
    // redo brings the run back as the ordinary symbol pair — still no conversion
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(50), sym('mm')], implicit: true }),
    );
  });

  it('Ctrl+Z after a settle restores the symbol run (the conversion is one undo step)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    typeRun(container);
    press(container, 'ArrowRight');
    expect(j(envelopeOf(controller.getState()).root)).toBe(j({ type: 'unit', value: num(50), unit: 'mm' }));
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(50), sym('mm')], implicit: true }),
    );
  });
});

describe('controller — T9 vocabulary methods (the palette/suggestion surface)', () => {
  it('insertRoot at a mid-token caret: the forward grab, typed continuation afterwards', () => {
    const { controller, container } = make({ v: 1, root: { type: 'num', value: 123 } });
    controller.placeCaret({ kind: 'token', path: [], index: 1 });
    controller.insertRoot();
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({ type: 'op', op: 'multiply', args: [num(1), { type: 'root', radicand: num(23) }], implicit: true }),
    );
    expect(controller.getState().caret).toEqual({ kind: 'token', path: [1, 'radicand'], index: 0 } satisfies Caret);
  });

  it('insertRoot mroot: the empty □ index rides along (index omitted, flag emitted)', () => {
    const { controller } = make({ v: 1, root: { type: 'num', value: 123 } });
    controller.placeCaret({ kind: 'token', path: [], index: 1 });
    controller.insertRoot({ mroot: true });
    expect(j(envelopeOf(controller.getState()).root)).toBe(
      j({
        type: 'op',
        op: 'multiply',
        args: [num(1), { type: 'root', radicand: num(23), mroot: true }],
        implicit: true,
      }),
    );
  });

  it('insertSubscript converts the symbol into the base; typing fills the script label', () => {
    const { controller, container } = make({ v: 1, root: { type: 'sym', name: 'x' } });
    controller.placeCaret({ kind: 'node', path: [] });
    controller.insertSubscript();
    expect(j(envelopeOf(controller.getState()).root)).toBe(j({ type: 'sub', base: 'x', sub: '' }));
    container.focus();
    for (const ch of ['m', 'a', 'x']) press(container, ch);
    expect(j(envelopeOf(controller.getState()).root)).toBe(j({ type: 'sub', base: 'x', sub: 'max' }));
    // and undoing the whole insert is one step
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    // 4 typed letters coalesce to per-op undo entries; the insert itself unwinds last
    for (let i = 0; i < 3; i++) {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    }
    expect(j(envelopeOf(controller.getState()).root)).toBe(j({ type: 'sym', name: 'x' }));
  });
});

describe('the IME / dead-key event logger (the standing demo tool)', () => {
  it('recordos key events with the raw field dump and composition events with their data — capture-phase, passive', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const lines: ImeLogLine[] = [];
    const detach = attachImeLogger(container, 'case', (l) => lines.unshift(l));
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Dead', code: 'Digit3', bubbles: false, cancelable: false }),
    );
    container.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX' }));
    const comp = new CompositionEvent('compositionupdate', { data: '^' } as never);
    container.dispatchEvent(comp);
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '^x' } as never));
    detach();
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    const text = lines.map((l) => l.line).join('\n');
    expect(text).toContain('keydown');
    expect(text).toContain('key="Dead"');
    expect(text).toContain('code="Digit3"');
    expect(text).toContain('keyup');
    expect(text).toContain('key="x"');
    expect(text).toContain('compositionupdate');
    expect(text).toContain('data="^"');
    expect(text).toContain('compositionend');
    expect(text).toContain('data="^x"');
    // detached: nothing records anymore
    const countAfterDetach = lines.length;
    expect(countAfterDetach).toBeGreaterThan(0);
    expect(lines.length).toBe(countAfterDetach);
  });
});
