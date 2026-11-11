// @vitest-environment jsdom
// EditorController: full rebuild per tree change (fresh <math> instance via
// replaceChild, no child-level reuse), caret-only placement does NOT rebuild,
// apply/undo wiring, and the click handler end-to-end.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { EngineError } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  stubRects({ container: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope });
  return { controller, container };
}

describe('EditorController: full rebuild per tree change', () => {
  it('an applied op replaces the <math> element — fresh instance, no child-level reuse', () => {
    const { controller, container } = make({ v: 1, root: null });
    const math1 = controller.getRendered()!.math;
    expect(container.contains(math1)).toBe(true);
    expect(math1.querySelectorAll('[id]').length).toBe(0);

    controller.apply({ op: 'insert', node: { type: 'op', op: 'add', args: [sym('a')] }, at: { at: 'root' } });
    const math2 = controller.getRendered()!.math;
    expect(math2).not.toBe(math1);
    expect(math1.isConnected).toBe(false); // old tree fully detached
    expect(container.contains(math2)).toBe(true);
    expect(container.firstElementChild).toBe(math2); // [math, caretDiv] order kept
    expect(container.querySelector('.integral-caret')).not.toBeNull();
    expect(math2.querySelectorAll('[id]').length).toBe(2); // exactly the op + a nodes

    // a second op → yet another fresh instance; no element is reused across builds
    controller.apply({ op: 'insert', node: num(9), at: { at: 'row', path: [], index: 1 } });
    const math3 = controller.getRendered()!.math;
    expect(math3).not.toBe(math2);
    expect(math3.querySelectorAll('[id]').length).toBe(3);
    expect([...math3.querySelectorAll('[id]')].some((el) => math2.contains(el))).toBe(false);
  });

  it('caret-only placement does not rebuild the MathML and never logs', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    const math = controller.getRendered()!.math;
    controller.apply({ op: 'insert', node: num(1), at: { at: 'row', path: [], index: 2 } });
    const mathAfterOp = controller.getRendered()!.math;
    expect(mathAfterOp).not.toBe(math);
    const logLen = controller.getState().log.length;

    controller.placeCaret({ kind: 'row', path: [], index: 1 });
    expect(controller.getRendered()!.math).toBe(mathAfterOp); // same instance
    expect(controller.getState().caret).toEqual({ kind: 'row', path: [], index: 1 });
    expect(controller.getState().log.length).toBe(logLen);
    expect(controller.getState().root).not.toBeNull();
  });

  it('undo restores the previous tree envelope and caret, one log entry at a time', () => {
    const { controller } = make({ v: 1, root: null });
    controller.apply({ op: 'insert', node: num(5), at: { at: 'root' } });
    expect(controller.getState().log.length).toBe(1);
    expect(controller.getEnvelope().root).toEqual(num(5));
    controller.undo();
    expect(controller.getEnvelope().root).toBeNull();
    expect(controller.getState().caret).toEqual({ kind: 'empty' });
    expect(controller.getState().log.length).toBe(0);
    controller.undo(); // empty log: defined no-op
    expect(controller.getEnvelope().root).toBeNull();
  });

  it('placeCaret rejects a caret that does not resolve (typed engine error)', () => {
    const { controller } = make({ v: 1, root: num(5) });
    let caught: unknown;
    try {
      controller.placeCaret({ kind: 'row', path: [], index: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe('caret-invalid');
    // 4a re-pin (OA-token-end): the seed rests at the lone token's in-token end
    expect(controller.getState().caret).toEqual({ kind: 'token', path: [], index: 1 }); // unchanged
  });

  it('end-to-end click: dispatch on a leaf places the nearest character edge (C1, 4b-2 re-pin — was the adjacent seam)', () => {
    const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    const stub = stubRects({ container: { left: 0, top: 0, width: 300, height: 40 } });
    const rendered = controller.getRendered()!;
    stub.setMath({ left: 0, top: 0, width: 25, height: 10 });
    stub.syncPath(rendered, {
      '[]': { left: 0, top: 0, width: 25, height: 10 },
      '[0]': { left: 0, top: 0, width: 10, height: 10 },
      '[1]': { left: 15, top: 0, width: 10, height: 10 },
    });
    const b = rendered.elementByPath.get('[1]')!;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 24 })); // fraction 0.9 of b (len 1) → offset 1
    expect(controller.getState().caret).toEqual({ kind: 'token', path: [1], index: 1 });
    expect(controller.getState().log.length).toBe(0);
    expect(container.contains(rendered.math)).toBe(true);
  });
});
