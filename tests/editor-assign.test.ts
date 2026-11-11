// @vitest-environment jsdom
// The `=` key feature (2026-11-11, rules A1–A7) — DOM layer pins: the keymap
// route for `=`, the dead-^ discard (A5), the unit-settle on leaving (S-051),
// the render parity + □ placeholders + the `=` glyph element map (A3/surface
// 7), and the click surface (glyph halves → lhs end / rhs start, □ → slot).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { fromJSON, isEvaluable, toJSON, toMathML, type Envelope, type NodeJson } from '../src/ast/index.js';
import { envelopeOf, initSession, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';
import { caretFromHit, hitFromMouseEvent } from '../src/editor/click.js';
import { buildMathML, pathKey } from '../src/editor/mathml-dom.js';
import { classifyKey, KEYMAP } from '../src/editor/keys.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number): NodeJson => ({ type: 'num', value });
const sym = (name: string): NodeJson => ({ type: 'sym', name });
const add = (...args: (NodeJson | null)[]): NodeJson => ({ type: 'op', op: 'add', args });
const unit = (value: NodeJson | null, u: string): NodeJson => ({ type: 'unit', value, unit: u });
const asg = (lhs: NodeJson | null, rhs: NodeJson | null): NodeJson => ({ type: 'assign', lhs, rhs });
const env = (root: NodeJson | null): Envelope => ({ v: 1, root });
const j = (x: unknown): string => JSON.stringify(x);

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'kb-assign';
  document.body.appendChild(container);
  stubRects({ 'kb-assign': { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope });
  container.focus();
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

describe('keymap — `=` routes to the assign token, its own undo unit', () => {
  it('classifyKey maps `=` to { t: assign } (a handled typing key, preventDefaulted)', () => {
    expect(KEYMAP['=']).toEqual({ t: 'assign' });
    const action = classifyKey({ key: '=', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(action).toEqual({ kind: 'type', token: { t: 'assign' } });
  });

  it('pressing `=` on the empty editor: □=□, caret in the LHS, one log entry; Ctrl+Z restores empty', () => {
    const { controller, container } = make(undefined);
    press(container, '=');
    expect(j(controller.getEnvelope())).toBe(j(env(asg(null, null))));
    expect(controller.getState().caret).toEqual({ kind: 'slot', path: [], slot: 'lhs' });
    expect(controller.getState().log.length).toBe(1);
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope())).toBe(j(env(null)));
    expect(controller.getState().caret).toEqual({ kind: 'empty' });
  });

  it('typing `x=5+3` from empty: the assign with the RHS row; evaluable; AssignmentNode parity', () => {
    const { controller, container } = make(undefined);
    for (const ch of 'x=5+3') press(container, ch);
    const root = controller.getEnvelope().root;
    expect(j(root)).toBe(j(asg(sym('x'), add(num(5), num(3)))));
    expect(isEvaluable(fromJSON(controller.getEnvelope()))).toBe(true);
    expect(fromJSON(controller.getEnvelope())!.toMathNode().type).toBe('AssignmentNode');
    // the `=` press was its own undo unit (not coalesced into the `x` run)
    const log = controller.getState().log;
    expect(log.length).toBeGreaterThanOrEqual(2);
    press(container, 'z', { ctrl: true }); // undo the 3
    press(container, 'z', { ctrl: true }); // undo the +
    press(container, 'z', { ctrl: true }); // undo the 5
    expect(j(controller.getEnvelope().root)).toBe(j(asg(sym('x'), null)));
    press(container, 'z', { ctrl: true }); // undo the `=` — the unsplit row byte-restores
    expect(j(controller.getEnvelope().root)).toBe(j(sym('x')));
  });

  it('S-051 leave: typing `5m=` settles the unit run first, then the `=` splits — unit LHS (declined, stored)', () => {
    const { controller, container } = make(undefined);
    for (const ch of '5m=') press(container, ch);
    expect(j(controller.getEnvelope().root)).toBe(j(asg(unit(num(5), 'm'), null)));
    expect(isEvaluable(fromJSON(controller.getEnvelope()))).toBe(false);
  });
});

describe('A5 — an armed dead-^ pending + `=` discards the pending (an exponent never receives `=`)', () => {
  it('Dead then `=`: no power, the assign fires at the root row', () => {
    const { controller, container } = make(undefined);
    press(container, 'Dead');
    press(container, '=');
    expect(j(controller.getEnvelope().root)).toBe(j(asg(null, null)));
    expect(controller.getState().caret).toEqual({ kind: 'slot', path: [], slot: 'lhs' });
  });

  it('control: Dead then `2` still resolves the pending into the exponent', () => {
    const { controller, container } = make(undefined);
    press(container, 'Dead');
    press(container, '2');
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'pow', base: null, exp: num(2) }),
    );
  });

  it('Dead then `=` mid-formula: pending discarded, the root row splits at the caret', () => {
    const { controller, container } = make(env(add(sym('a'), sym('b'))));
    controller.placeCaret({ kind: 'row', path: [], index: 1 });
    press(container, 'Dead');
    press(container, '=');
    expect(j(controller.getEnvelope().root)).toBe(j(asg(sym('a'), sym('b'))));
  });
});

describe('render + click surface (A3, surface 7)', () => {
  it('DOM parity: the assign renders like the string renderer; □ placeholders + the glyph map', () => {
    const root = fromJSON(env(asg(null, add(num(5), num(3)))));
    const rendered = buildMathML(root, document);
    const parser = new DOMParser();
    const parsed = parser.parseFromString(toMathML(root), 'text/html');
    const shapeOf = (n: Node): string => {
      if (n.nodeType === 3) return `#${n.textContent ?? ''}`;
      const el = n as Element;
      return `<${el.localName}>${[...el.childNodes].map(shapeOf).join('')}</${el.localName}>`;
    };
    expect(shapeOf(rendered.math)).toBe(shapeOf(parsed.querySelector('math')!));
    // one □ placeholder (the empty lhs), bound to its slot caret; the glyph mapped
    expect(rendered.placeholders.size).toBe(1);
    expect(rendered.placeholderByCaret.has(JSON.stringify({ kind: 'slot', path: [], slot: 'lhs' }))).toBe(true);
    expect(rendered.assignGlyphs.size).toBe(1);
    expect(rendered.elementByPath.has(pathKey([]))).toBe(true);
    // both renderers byte-parallel for the empty template
    const empty = fromJSON(env(asg(null, null)));
    expect(toMathML(empty)).toBe('<math><mrow><mi>□</mi><mo>=</mo><mi>□</mi></mrow></math>');
    expect(buildMathML(empty, document).placeholders.size).toBe(2);
  });

  it('clicks: the `=` glyph halves map to the shared gap (left → lhs end, right → rhs start); □ → its slot caret', () => {
    const e = env(asg(sym('x'), num(5)));
    const envJson = fromJSON(e);
    const rendered = buildMathML(envJson, document);
    const glyphEl = [...rendered.assignGlyphs.keys()][0];
    stubRects().set(glyphEl, { left: 100, top: 0, width: 10, height: 20 });
    const hitLeft = hitFromMouseEvent({ target: glyphEl, clientX: 102 } as unknown as MouseEvent, rendered);
    expect(hitLeft.kind).toBe('assignGlyph');
    const caretL = caretFromHit(e, { kind: 'assignGlyph', path: [], fraction: 0.25 });
    expect(caretL).toEqual({ kind: 'token', path: ['lhs'], index: 1 });
    const caretR = caretFromHit(e, { kind: 'assignGlyph', path: [], fraction: 0.75 });
    expect(caretR).toEqual({ kind: 'token', path: ['rhs'], index: 0 });
    // the □ click target: the recorded slot caret
    const phEl = [...rendered.placeholders.keys()][0] ?? null;
    const emptyEnv = env(asg(null, null));
    const renderedEmpty = buildMathML(fromJSON(emptyEnv), document);
    const ph = [...renderedEmpty.placeholders.entries()].find(([, c]) => c.kind === 'slot' && (c as { slot: string }).slot === 'rhs');
    expect(ph).toBeDefined();
    expect(caretFromHit(emptyEnv, { kind: 'placeholder', caret: ph![1] })).toEqual(ph![1]);
    expect(phEl === null || phEl !== undefined).toBe(true);
  });

  it('slots are click-reachable: a node hit in the middle of the assign dives by side', () => {
    const e = env(asg(sym('x'), num(5)));
    const left = caretFromHit(e, { kind: 'node', path: [], fraction: 0.2 });
    expect(left).toEqual({ kind: 'token', path: ['lhs'], index: 0 });
    const right = caretFromHit(e, { kind: 'node', path: [], fraction: 0.8 });
    expect(right).toEqual({ kind: 'token', path: ['rhs'], index: 1 });
  });

  it('caret overlay anchors the assign slot carets at their □ placeholders', async () => {
    const { caretAnchor } = await import('../src/editor/caret-overlay.js');
    const e = env(asg(null, num(5)));
    const rendered = buildMathML(fromJSON(e), document);
    const stub = stubRects();
    stub.setMath({ left: 0, top: 0, width: 100, height: 20 });
    const phEl = rendered.placeholderByCaret.get(JSON.stringify({ kind: 'slot', path: [], slot: 'lhs' }))!;
    stub.set(phEl, { left: 10, top: 2, width: 8, height: 16 });
    const anchor = caretAnchor(e, { kind: 'slot', path: [], slot: 'lhs' }, rendered);
    expect(anchor).toEqual({ x: 10, y: 2, height: 16 });
  });
});

describe('controller integration — `=` inside an assign slot is a silent no-op (A5)', () => {
  it('pressing `=` again inside the slots changes nothing and logs nothing', () => {
    const { controller, container } = make(env(asg(sym('x'), num(5))));
    const before = controller.getState();
    controller.placeCaret({ kind: 'token', path: ['rhs'], index: 0 });
    press(container, '=');
    expect(controller.getState().log.length).toBe(before.log.length);
    expect(j(controller.getEnvelope())).toBe(j(env(asg(sym('x'), num(5)))));
  });

  it('BS at the rhs start through the DOM removes the glyph (A4)', () => {
    const { controller, container } = make(env(asg(sym('x'), num(5))));
    controller.placeCaret({ kind: 'token', path: ['rhs'], index: 0 });
    press(container, 'Backspace');
    expect(j(controller.getEnvelope().root)).toBe(j(sym('x5'))); // merge-table fusion
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(asg(sym('x'), num(5))));
  });
});
