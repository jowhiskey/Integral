// Redo (additive engine extension, DOM-layer session 2): a redo list of undone
// entries on EditingState; any new tree-changing op clears it; redo-on-empty
// is a defined no-op. Pure engine tests — no DOM.

import { describe, expect, it } from 'vitest';

import {
  applyOp,
  envelopeOf,
  initSession,
  redo,
  undo,
  type EditingState,
} from '../src/engine/index.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;

const snap = (s: EditingState): string =>
  JSON.stringify([envelopeOf(s), s.caret, s.log.length, s.log.map((e) => e.op)]);

describe('redo (engine)', () => {
  it('starts empty; redo on an empty list is a defined no-op returning the same state object', () => {
    const s = initSession();
    expect(s.redo).toEqual([]);
    expect(redo(s)).toBe(s);
    // undo on an empty log is still the pinned no-op and leaves redo untouched
    expect(undo(s)).toBe(s);
  });

  it('undo pushes the popped entry onto the redo list; redo re-applies it byte-identically (tree + caret + log)', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: { type: 'op', op: 'add', args: [num(5)] }, at: { at: 'root' } });
    s = applyOp(s, { op: 'insert', node: num(3), at: { at: 'row', path: [], index: 1 } });
    const after = s;
    const afterSnap = snap(after);

    const undone = undo(after);
    expect(undone).not.toBe(after);
    expect(undone.log.length).toBe(1);
    expect(undone.redo.length).toBe(1);
    expect(JSON.stringify(envelopeOf(undone))).toBe(JSON.stringify({ v: 1, root: { type: 'op', op: 'add', args: [num(5)] } }));

    const redone = redo(undone);
    expect(redone).not.toBe(undone);
    expect(snap(redone)).toBe(afterSnap); // byte-identical tree + caret + log shape
    expect(redone.redo.length).toBe(0);
    expect(JSON.stringify(redone.log[1].op)).toBe(JSON.stringify(after.log[1].op));
  });

  it('multi-entry: undo, undo, redo, redo walks the log stepwise byte-identically', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: num(1), at: { at: 'root' } });
    const s1 = s;
    s = applyOp(s, { op: 'insert', node: { type: 'op', op: 'add', args: [num(2)] }, at: { at: 'replaceRoot' } });
    const s2 = s;
    s = applyOp(s, { op: 'insert', node: num(3), at: { at: 'row', path: [], index: 1 } });
    const s3 = s;

    let cur = undo(undo(s3));
    expect(snap(cur)).toBe(snap(s1));
    expect(cur.redo.length).toBe(2);
    cur = redo(cur);
    expect(snap(cur)).toBe(snap(s2));
    cur = redo(cur);
    expect(snap(cur)).toBe(snap(s3));
    expect(redo(cur)).toBe(cur); // redo-on-empty no-op after the list drains
  });

  it('a new tree-changing op after undo clears the redo list; a later redo is a no-op', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: num(5), at: { at: 'root' } });
    s = undo(s);
    expect(s.redo.length).toBe(1);
    s = applyOp(s, { op: 'insert', node: num(7), at: { at: 'root' } });
    expect(s.redo.length).toBe(0);
    const before = s;
    expect(redo(s)).toBe(before); // defined no-op
    expect(JSON.stringify(envelopeOf(s))).toBe(JSON.stringify({ v: 1, root: num(7) }));
  });

  it('pure movement and moveCaret do not clear the redo list (only tree-changing ops do)', () => {
    let s = initSession({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    s = applyOp(s, { op: 'insert', node: num(9), at: { at: 'row', path: [], index: 2 } });
    s = undo(s);
    expect(s.redo.length).toBe(1);
    s = applyOp(s, { op: 'move', dir: 'left' }); // never logged, never clears redo
    expect(s.redo.length).toBe(1);
    s = applyOp(s, { op: 'moveCaret', to: { kind: 'row', path: [], index: 0 } });
    expect(s.redo.length).toBe(1);
    // and redo still works afterwards, restoring the undone insert
    const r = redo(s);
    expect(r.redo.length).toBe(0);
    expect(JSON.stringify(envelopeOf(r))).toBe(
      JSON.stringify({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), num(9)] } }),
    );
  });

  it('undo/redo of a logged moveCaret restores the caret byte-identically', () => {
    let s = initSession({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
    s = applyOp(s, { op: 'moveCaret', to: { kind: 'row', path: [], index: 2 } });
    const caretAfter = JSON.stringify(s.caret);
    s = undo(s);
    expect(JSON.stringify(s.caret)).toBe(JSON.stringify({ kind: 'node', path: [] }));
    s = redo(s);
    expect(JSON.stringify(s.caret)).toBe(caretAfter);
    expect(s.log.length).toBe(1);
  });
});
