// @vitest-environment jsdom
// Caret geometry: given caret states + stubbed element rects, the caret anchor
// (and the overlay div's coordinates inside the container) match pinned values
// per caret kind: node / slot / row (seam before a cell, after the last cell,
// empty cell placeholder, empty row) / empty formula.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fromJSON, toJSON, type Envelope } from '../src/ast/index.js';
import type { Caret } from '../src/engine/index.js';
import { caretAnchor, updateCaretOverlay } from '../src/editor/caret-overlay.js';
import { EditorController } from '../src/editor/controller.js';
import { buildMathML, caretKey } from '../src/editor/mathml-dom.js';
import { stubRects, type Rect } from './editor-support.js';

afterEach(() => vi.restoreAllMocks());

const sym = (name: string) => ({ type: 'sym', name }) as const;
const num = (value: number) => ({ type: 'num', value }) as const;

describe('caretAnchor per caret kind (stubbed rects)', () => {
  it('node caret → left edge of the node extent; slot caret → placeholder; empty → math element', () => {
    // frac(5, □)
    const env: Envelope = { v: 1, root: { type: 'frac', num: num(5), den: null } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    stub.setMath({ left: 100, top: 50, width: 40, height: 30 });
    stub.syncPath(rendered, {
      '[]': { left: 105, top: 55, width: 30, height: 20 },
      '["num"]': { left: 110, top: 58, width: 8, height: 8 },
    });
    stub.syncCaret(rendered, {
      [caretKey({ kind: 'slot', path: [], slot: 'den' })]: { left: 110, top: 70, width: 8, height: 8 },
    });

    expect(caretAnchor(env, { kind: 'node', path: [] }, rendered)).toEqual({ x: 105, y: 55, height: 20 });
    expect(caretAnchor(env, { kind: 'node', path: ['num'] }, rendered)).toEqual({ x: 110, y: 58, height: 8 });
    expect(caretAnchor(env, { kind: 'slot', path: [], slot: 'den' }, rendered)).toEqual({ x: 110, y: 70, height: 8 });

    const emptyEnv: Envelope = { v: 1, root: null };
    const emptyRendered = buildMathML(null, document);
    expect(caretAnchor(emptyEnv, { kind: 'empty' }, emptyRendered)).toEqual({ x: 100, y: 50, height: 30 });
  });

  it('row caret → left edge of the addressed cell, right edge after the last cell, bare cell at the flanking glyph, empty row', () => {
    // add(a, □, b) — re-pinned (T7 split): the op row's null cell has NO
    // placeholder element; the caret anchors at the PRECEDING separator
    // glyph's right edge (the anchor fallback for bare cells).
    const env: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null, sym('b')] } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    stub.syncPath(rendered, {
      '[]': { left: 0, top: 0, width: 35, height: 10 },
      '[0]': { left: 0, top: 0, width: 10, height: 10 },
      '[2]': { left: 25, top: 0, width: 10, height: 10 },
    });
    const sep1 = [...rendered.separators.entries()].find(([, s]) => s.index === 1)![0];
    const sep2 = [...rendered.separators.entries()].find(([, s]) => s.index === 2)![0];
    stub.set(sep1, { left: 10, top: 0, width: 5, height: 10 });
    stub.set(sep2, { left: 20, top: 0, width: 5, height: 10 });

    expect(caretAnchor(env, { kind: 'row', path: [], index: 0 }, rendered)).toEqual({ x: 0, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'row', path: [], index: 1 }, rendered)).toEqual({ x: 15, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'row', path: [], index: 2 }, rendered)).toEqual({ x: 25, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'row', path: [], index: 3 }, rendered)).toEqual({ x: 35, y: 0, height: 10 });

    // empty row: the seam anchors at the row owner's own element
    const emptyRowEnv: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [] } };
    const emptyRow = buildMathML(fromJSON(emptyRowEnv), document);
    stub.syncPath(emptyRow, { '[]': { left: 3, top: 4, width: 10, height: 12 } });
    expect(caretAnchor(emptyRowEnv, { kind: 'row', path: [], index: 0 }, emptyRow)).toEqual({ x: 3, y: 4, height: 12 });
  });

  it('unit node caret → left edge of the whole fragment (value first), not the label', () => {
    const env: Envelope = { v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    stub.syncPath(rendered, {
      '["value"]': { left: 0, top: 0, width: 10, height: 10 },
      '[]': { left: 24, top: 0, width: 6, height: 10 }, // own element = the upright label
    });
    // extent spans first..last fragment element: value mn .. label mi
    expect(caretAnchor(env, { kind: 'node', path: [] }, rendered)).toEqual({ x: 0, y: 0, height: 10 });
  });

  it('unit LABEL token carets interpolate within the label element (S-104), not the whole unit extent', () => {
    const env: Envelope = { v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    stub.syncPath(rendered, {
      '["value"]': { left: 0, top: 0, width: 10, height: 10 },
      '[]': { left: 24, top: 0, width: 6, height: 10 }, // label mi: x 24..30
    });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 0 }, rendered)).toEqual({ x: 24, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 1 }, rendered)).toEqual({ x: 27, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 2 }, rendered)).toEqual({ x: 30, y: 0, height: 10 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 3 }, rendered)).toEqual(null); // out of the label
  });

  it('sub LABEL token carets anchor within their own label element (T9), base and script separately', () => {
    const env: Envelope = { v: 1, root: { type: 'sub', base: 'x', sub: 'max' } };
    const rendered = buildMathML(fromJSON(env), document);
    const stub = stubRects();
    const labels = rendered.subLabels.get('[]')!;
    expect(labels).toBeDefined();
    stub.set(labels.base, { left: 0, top: 2, width: 4, height: 8 });
    stub.set(labels.script, { left: 6, top: 0, width: 9, height: 6 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 0, label: 'base' }, rendered)).toEqual({ x: 0, y: 2, height: 8 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 1, label: 'base' }, rendered)).toEqual({ x: 4, y: 2, height: 8 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 0, label: 'sub' }, rendered)).toEqual({ x: 6, y: 0, height: 6 });
    expect(caretAnchor(env, { kind: 'token', path: [], index: 2, label: 'sub' }, rendered)).toEqual({ x: 12, y: 0, height: 6 });
    // a label-less token caret on a sub never anchors
    expect(caretAnchor(env, { kind: 'token', path: [], index: 0 }, rendered)).toEqual(null);
  });
});

describe('updateCaretOverlay: the overlay div is positioned relative to the container', () => {
  it('div coordinates = anchor − container rect, per caret kind', () => {
    const container = document.createElement('div');
    container.id = 'container';
    document.body.appendChild(container);
    const stub = stubRects({ container: { left: 100, top: 50, width: 300, height: 40 } });
    stub.setMath({ left: 100, top: 50, width: 300, height: 40 });

    const env: Envelope = { v: 1, root: { type: 'frac', num: num(5), den: null } };
    const controller = new EditorController(container, { envelope: env });
    const rendered = controller.getRendered()!;
    stub.syncPath(rendered, {
      '[]': { left: 105, top: 55, width: 30, height: 20 },
      '["num"]': { left: 110, top: 58, width: 8, height: 8 },
    });
    stub.syncCaret(rendered, {
      [caretKey({ kind: 'slot', path: [], slot: 'den' })]: { left: 110, top: 70, width: 8, height: 8 },
    });
    const caretDiv = container.querySelector('.integral-caret') as HTMLElement;

    // initial caret: node [] → anchor (105,55,20) → container-relative (5,5,20)
    controller.updateCaret();
    expect(caretDiv.style.left).toBe('5px');
    expect(caretDiv.style.top).toBe('5px');
    expect(caretDiv.style.height).toBe('20px');
    expect(caretDiv.style.display).toBe('block');

    controller.placeCaret({ kind: 'node', path: ['num'] });
    expect(caretDiv.style.left).toBe('10px');
    expect(caretDiv.style.top).toBe('8px');
    expect(caretDiv.style.height).toBe('8px');

    controller.placeCaret({ kind: 'slot', path: [], slot: 'den' });
    expect(caretDiv.style.left).toBe('10px');
    expect(caretDiv.style.top).toBe('20px');
    expect(caretDiv.style.height).toBe('8px');
  });

  it('empty formula: the caret sits at the math element\'s left edge', () => {
    const container = document.createElement('div');
    container.id = 'container';
    document.body.appendChild(container);
    const stub = stubRects({ container: { left: 100, top: 50, width: 300, height: 40 } });
    stub.setMath({ left: 102, top: 54, width: 0, height: 24 });
    const controller = new EditorController(container, { envelope: { v: 1, root: null } });
    controller.updateCaret();
    const caretDiv = container.querySelector('.integral-caret') as HTMLElement;
    expect(caretDiv.style.left).toBe('2px');
    expect(caretDiv.style.top).toBe('4px');
    expect(caretDiv.style.height).toBe('24px');
  });

  it('updateCaretOverlay standalone: null anchor hides the div', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    stubRects();
    const caretDiv = document.createElement('div');
    const env: Envelope = { v: 1, root: num(1) };
    const rendered = buildMathML(fromJSON(env), document);
    updateCaretOverlay(caretDiv, container, env, { kind: 'node', path: [7] }, rendered); // not in the maps
    expect(caretDiv.style.display).toBe('none');
  });
});
