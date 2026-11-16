// @vitest-environment jsdom
// EditorController.getOpLog(): the versioned host-facing op-log serialization
// on the live controller — format v1, mirroring the runtime undo stack (undo
// pops entries, redo re-logs them, reset clears the log), and walkable back
// op-by-op from getEnvelope() plus the log alone.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import type { NodeJson } from '../src/ast/json.js';
import { applyRevOp, type Envelope, type Op } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const j = (x: unknown): string => JSON.stringify(x);
const SEED: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };

/** One insert at a root-row index — one undo unit per controller.apply. */
const rowAt = (node: NodeJson | null, index: number): Op => ({ op: 'insert', node, at: { at: 'row', path: [], index } });

function make(): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  stubRects({ container: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope: SEED });
  return { controller, container };
}

describe('EditorController.getOpLog()', () => {
  it('returns a v1 log mirroring the runtime undo stack, with a reverse step attached to every op', () => {
    const { controller } = make();
    expect(controller.getOpLog()).toEqual({ v: 1, entries: [] });
    const op1 = rowAt(num(5), 2);
    controller.apply(op1);
    const op2 = rowAt(sym('c'), 3);
    controller.apply(op2);
    const log = controller.getOpLog();
    expect(log.v).toBe(1);
    expect(log.entries.length).toBe(2);
    expect(log.entries.length).toBe(controller.getState().log.length);
    expect(log.entries[0].ops[0].op).toEqual(op1);
    expect(log.entries[0].before).toEqual(SEED);
    expect(log.entries[1].ops[0].op).toEqual(op2);
    for (const entry of log.entries) {
      for (const sop of entry.ops) expect(sop.rev).toBeDefined();
    }
  });

  it('reflects the live stack: undo pops an entry, redo re-logs it, reset clears the log', () => {
    const { controller } = make();
    controller.apply(rowAt(num(5), 2));
    controller.apply(rowAt(sym('c'), 3));
    expect(controller.getOpLog().entries.length).toBe(2);
    controller.undo();
    expect(controller.getOpLog().entries.length).toBe(1);
    controller.redo();
    expect(controller.getOpLog().entries.length).toBe(2);
    controller.reset({ v: 1, root: null });
    expect(controller.getOpLog()).toEqual({ v: 1, entries: [] });
    expect(j(controller.getEnvelope())).toBe(j({ v: 1, root: null }));
  });

  it('walks the session back op-by-op from getEnvelope() + the log alone to the initial envelope', () => {
    const { controller } = make();
    controller.apply(rowAt(num(5), 2));
    controller.apply(rowAt(null, 3)); // null-cell splice
    controller.apply(rowAt(sym('c'), 4));
    const log = controller.getOpLog();
    let env = controller.getEnvelope();
    for (let e = log.entries.length - 1; e >= 0; e--) {
      for (let i = log.entries[e].ops.length - 1; i >= 0; i--) {
        env = applyRevOp(env, log.entries[e].ops[i].rev, controller.getState().vocabulary);
      }
      expect(j(env)).toBe(j(log.entries[e].before));
    }
    expect(j(env)).toBe(j(SEED));
  });
});
