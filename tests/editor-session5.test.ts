// @vitest-environment jsdom
// Rework session 5 — the DOM-layer half: U1 undo coalescing driven through the
// real keydown path (the ruled traces S-082 / S-085 / S-086 + the run-closer
// walk), K1 iterative Home/End, K2/K3 blur-commit, and the ValidationError
// catch-classification rider (the mroot □-index shape).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { envelopeOf, type Caret } from '../src/engine/index.js';
import { EditorController } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const j = (x: unknown): string => JSON.stringify(x);
const tok = (path: (number | string)[], index: number): Caret => ({ kind: 'token', path, index });
const rowc = (path: (number | string)[], index: number): Caret => ({ kind: 'row', path, index });
const sl = (path: (number | string)[], slot: string): Caret => ({ kind: 'slot', path, slot: slot as never });

function make(envelope: unknown): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 's5';
  document.body.appendChild(container);
  stubRects({ s5: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope });
  return { controller, container };
}

interface KeyOpts {
  ctrl?: boolean;
  shift?: boolean;
}

function press(container: HTMLElement, key: string, opts: KeyOpts = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
  });
  container.dispatchEvent(ev);
  return ev;
}

const snap = (c: EditorController): string => j([c.getEnvelope(), c.getState().caret, c.getState().log.length]);

describe('session 5 — U1: the ruled undo traces through the keyboard path', () => {
  it('S-082 typo-fix chain: retype → backspace → original run, three undos in that order, byte-exact', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const fwd: string[] = [];
    for (const ch of ['x', 'y', 'z']) press(container, ch);
    fwd.push(snap(controller));
    press(container, 'Backspace');
    fwd.push(snap(controller));
    press(container, 'w');
    fwd.push(snap(controller));
    // units: [x,y,z] run, [Backspace], [w] run
    expect(controller.getState().log.length).toBe(3);
    expect(controller.getState().log.map((e) => e.ops.length)).toEqual([3, 1, 1]);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('xyw')));
    // undo the retype, then the backspace, then the original run
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(fwd[1]); // xy| — the retype undone
    expect(j(controller.getEnvelope().root)).toBe(j(sym('xy')));
    expect(j(controller.getState().caret)).toBe(j(tok([], 2)));
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(fwd[0]); // xyz| — the backspace undone
    expect(j(controller.getEnvelope().root)).toBe(j(sym('xyz')));
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe('null'); // the original run undone
    expect(j(controller.getState().caret)).toBe(j({ kind: 'empty' }));
    expect(controller.getState().log.length).toBe(0);
    expect(controller.getState().redo.length).toBe(3);
    // redo walks forward byte-exactly
    press(container, 'y', { ctrl: true });
    expect(snap(controller)).toBe(fwd[0]);
    press(container, 'y', { ctrl: true });
    expect(snap(controller)).toBe(fwd[1]);
    press(container, 'y', { ctrl: true });
    expect(snap(controller)).toBe(fwd[2]);
    expect(controller.getState().redo.length).toBe(0);
  });

  it('S-085 function-conversion chain: `a+sin(a|)` → `a+sin(|□)` → `a+sin|` → `a+|`; the `(`-press + conversion is ONE unit', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const fwd: string[] = [];
    press(container, 'a');
    press(container, '+');
    fwd.push(snap(controller)); // a+|
    press(container, 'ArrowLeft'); // non-typing: closes the run
    press(container, 'ArrowRight'); // caret back at the pending cell
    for (const ch of ['s', 'i', 'n']) press(container, ch);
    fwd.push(snap(controller)); // a+sin|
    press(container, '('); // T5 conversion — structural: its own unit
    fwd.push(snap(controller)); // a+sin(|□)
    press(container, 'a');
    fwd.push(snap(controller)); // a+sin(a|)
    // OA-undo-burst (ruled 2026-11-10): every operator press is its OWN undo
    // unit — the units are [a], [+], [sin], [(+conversion], [a-arg]
    expect(controller.getState().log.length).toBe(5);
    expect(controller.getState().log.map((e) => e.ops.length)).toEqual([1, 1, 3, 1, 1]);
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('a'), { type: 'fn', name: 'sin', args: [sym('a')] }] }),
    );
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(fwd[2]); // a+sin(|□) — the arg run undone
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [sym('a'), { type: 'fn', name: 'sin', args: [null] }] }),
    );
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(fwd[1]); // a+sin| — the `(`+conversion unit reverts to the BARE SYMBOL (no leftover empty group)
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), sym('sin')] }));
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(fwd[0]); // a+| — the `sin` run undone
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'op', op: 'add', args: [sym('a'), null] }));
    press(container, 'z', { ctrl: true }); // OA-undo-burst: the `+` operator unit unwinds on its own
    expect(j(controller.getEnvelope().root)).toBe(j(sym('a')));
    expect(j(controller.getState().caret)).toBe(j(tok([], 1)));
    expect(controller.getState().log.length).toBe(1);
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe('null');
  });

  it('S-086 head swap: undo removes the typed `cos(` head in one step; the next undo restores the `sin(` head — two ordinary edits', () => {
    const seed = {
      v: 1,
      root: { type: 'fn', name: 'sin', args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }] },
    };
    const { controller, container } = make(seed);
    controller.placeCaret(rowc([], 0)); // the argument start
    container.focus();
    press(container, 'Backspace'); // D7(b): the atomic head dies, content + `)` survive
    const afterBs = snap(controller);
    expect(j(controller.getEnvelope().root)).toContain('fence');
    expect(controller.getState().log.length).toBe(1);
    for (const ch of ['c', 'o', 's', '(']) press(container, ch); // OA-rehead: rebinds the pair
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'fn', name: 'cos', args: [{ type: 'op', op: 'add', args: [sym('a'), sym('b')] }] }),
    );
    expect(controller.getState().log.length).toBe(2); // the swap = two units
    expect(controller.getState().log[1].ops.length).toBe(4); // `cos(` is ONE coalesced unit (the rebind `(` coalesces)
    press(container, 'z', { ctrl: true });
    expect(snap(controller)).toBe(afterBs); // one undo removes the whole typed cos( head
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(seed.root)); // the next undo restores the sin( head
    expect(j(controller.getState().caret)).toBe(j(rowc([], 0)));
  });
});

describe('session 5 — U1: run closers + a plain typing-run undo/redo walk', () => {
  it('arrow / click / Backspace / structure key each close the run; blur closes it too (K2/K3 test below)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    const envCaret = () => j([controller.getEnvelope().root, controller.getState().caret]);
    press(container, 'a');
    press(container, 'b'); // coalesced with a — ONE unit [a,b]
    expect(controller.getState().log.length).toBe(1);
    expect(controller.getState().log[0].ops.length).toBe(2);
    press(container, 'ArrowRight'); // closes the run (a no-op move at the end still closes)
    press(container, 'c'); // new unit
    expect(controller.getState().log.length).toBe(2);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('abc')));
    controller.placeCaret(tok([], 1)); // click closes the run
    press(container, 'x'); // glues mid-token: axbc — new unit
    expect(controller.getState().log.length).toBe(3);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('axbc')));
    press(container, 'Backspace'); // its own unit — deletes the x again
    expect(controller.getState().log.length).toBe(4);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('abc')));
    press(container, '/'); // structure key: own unit (OA-both-halves split a|bc → frac(a,bc))
    expect(controller.getState().log.length).toBe(5);
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: sym('a'), den: sym('bc') }));
    expect(controller.getState().log.map((e) => e.ops.length)).toEqual([2, 1, 1, 1, 1]);
    // undo walks the five units back byte-exactly (tree + caret)
    const back: string[] = [
      j([sym('abc'), tok([], 1)]), // the `/` unit undone
      j([sym('axbc'), tok([], 2)]), // the Backspace undone
      j([sym('abc'), tok([], 1)]), // the x-glue undone (caret back at the clicked offset)
      j([sym('ab'), tok([], 2)]), // the c run undone
      j([null, { kind: 'empty' }]), // the [a,b] run undone
    ];
    for (let k = 0; k < 5; k++) {
      press(container, 'z', { ctrl: true });
      expect(envCaret(), `undo #${k + 1}`).toBe(back[k]);
    }
    expect(controller.getState().log.length).toBe(0);
    expect(controller.getState().redo.length).toBe(5);
    // redo walks forward byte-exactly
    const fwd: string[] = [
      j([sym('ab'), tok([], 2)]),
      j([sym('abc'), tok([], 3)]),
      j([sym('axbc'), tok([], 2)]),
      j([sym('abc'), tok([], 1)]),
      j([{ type: 'frac', num: sym('a'), den: sym('bc') }, tok(['den'], 0)]),
    ];
    for (let k = 0; k < 5; k++) {
      press(container, 'y', { ctrl: true });
      expect(envCaret(), `redo #${k + 1}`).toBe(fwd[k]);
    }
    expect(controller.getState().redo.length).toBe(0);
  });

  it('the S-051 settle on a leaving key is its own unit and closes the run: `50mm` + `+`', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    for (const ch of ['5', '0', 'm', 'm']) press(container, ch);
    expect(controller.getState().log.length).toBe(1); // the run
    expect(controller.getState().log[0].ops.length).toBe(4);
    press(container, '+'); // settle converts 50mm → unit (own unit), then + types into a new run
    expect(controller.getState().log.length).toBe(3);
    expect(controller.getState().log.map((e) => e.ops.length)).toEqual([4, 1, 1]);
    expect(j(controller.getEnvelope().root)).toBe(
      j({ type: 'op', op: 'add', args: [{ type: 'unit', value: num(50), unit: 'mm' }, null] }),
    );
  });

  it('U2 re-pin through the keyboard: one undo unwinds the `/` structure creation incl. the node-grab (S-083)', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, 'b');
    press(container, '/');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'frac', num: sym('b'), den: null }));
    expect(controller.getState().log.length).toBe(2); // [b] run, [/] unit
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe(j(sym('b'))); // b back in the row, caret restored
    expect(j(controller.getState().caret)).toBe(j(tok([], 1)));
    press(container, 'z', { ctrl: true });
    expect(j(controller.getEnvelope().root)).toBe('null');
  });
});

describe('session 5 — K1: iterative Home/End through the keyboard path', () => {
  const nested = {
    v: 1,
    root: {
      type: 'op',
      op: 'add',
      args: [
        sym('x'),
        { type: 'frac', num: num(1), den: { type: 'op', op: 'add', args: [num(2), sym('abc')] } },
        sym('z'),
      ],
    },
  };

  it('in-token → slot row → enclosing row directly (S-105 A) → formula end; both directions; never a sibling slot; never logged', () => {
    const { controller, container } = make(nested);
    controller.placeCaret(tok([1, 'den', 1], 1)); // mid "abc" in the denominator
    container.focus();
    const logLen = controller.getState().log.length;

    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j(tok([1, 'den', 1], 3))); // local: abc end
    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j(tok([2], 1))); // S-105 A: directly the enclosing row's end (z), not the frac flank
    const atFormulaEnd = controller.getState();
    press(container, 'End');
    expect(controller.getState()).toBe(atFormulaEnd); // defined no-op at the formula end

    press(container, 'Home');
    expect(j(controller.getState().caret)).toBe(j(tok([2], 0)));
    press(container, 'Home');
    expect(j(controller.getState().caret)).toBe(j(tok([0], 0))); // formula row start = x's start
    const atFormulaStart = controller.getState();
    press(container, 'Home');
    expect(controller.getState()).toBe(atFormulaStart); // no-op

    // from the 2's end inside the slot: Home → 2's start → directly x's start
    controller.placeCaret(tok([1, 'den', 0], 1));
    press(container, 'Home');
    expect(j(controller.getState().caret)).toBe(j(tok([1, 'den', 0], 0)));
    press(container, 'Home');
    expect(j(controller.getState().caret)).toBe(j(tok([0], 0)));

    // from the numerator: End walks num end → enclosing row end — never into the denominator
    controller.placeCaret(tok([1, 'num'], 0));
    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j(tok([1, 'num'], 1)));
    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j(tok([2], 1)));
    expect(j(controller.getState().caret)).not.toContain('den');

    // Ctrl+Home/End stay unbound: pass through, no movement, not preventDefault'ed
    controller.placeCaret(tok([1, 'den', 1], 2));
    const before = controller.getState();
    const ctrlHome = press(container, 'Home', { ctrl: true });
    expect(ctrlHome.defaultPrevented).toBe(false);
    expect(controller.getState()).toBe(before);

    expect(controller.getState().log.length).toBe(logLen); // Home/End never log
  });

  it('flat row + fn after-station: Home/End on `sin(x,y)` escalate to the fence-past stations', () => {
    const { controller, container } = make({ v: 1, root: { type: 'fn', name: 'sin', args: [sym('x'), sym('y')] } });
    controller.placeCaret(tok([1], 0));
    container.focus();
    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j(tok([1], 1))); // y end
    press(container, 'End');
    expect(j(controller.getState().caret)).toBe(j({ kind: 'node', path: [], side: 'right' })); // past the close fence
    const end = controller.getState();
    press(container, 'End');
    expect(controller.getState()).toBe(end); // no-op
    press(container, 'Home');
    expect(j(controller.getState().caret)).toBe(j({ kind: 'node', path: [], side: 'left' })); // the fn's left border
    const atStart = controller.getState();
    press(container, 'Home');
    expect(controller.getState()).toBe(atStart); // no-op at the formula start
    expect(controller.getState().log.length).toBe(0);
  });
});

describe('session 5 — K2/K3: Enter/Tab/Escape commit + blur', () => {
  it('Enter commits and blurs: the blur event fires, state persists, keys gate while unfocused, and blur closed the typing run', () => {
    const { controller, container } = make({ v: 1, root: null });
    container.focus();
    press(container, 'a');
    expect(controller.getState().log.length).toBe(1);
    let blurCount = 0;
    container.addEventListener('blur', () => blurCount++);
    const ev = press(container, 'Enter');
    expect(ev.defaultPrevented).toBe(true); // K2: handled
    expect(blurCount).toBe(1); // Integral fired the blur — the host takes over from here
    expect(document.activeElement).not.toBe(container);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('a'))); // committed state persists
    expect(controller.getState().log.length).toBe(1); // commit adds no log entry
    press(container, 'b'); // gated while unfocused
    expect(j(controller.getEnvelope().root)).toBe(j(sym('a')));
    container.focus();
    press(container, 'b'); // the run was closed by the blur → a NEW unit
    expect(controller.getState().log.length).toBe(2);
    expect(j(controller.getEnvelope().root)).toBe(j(sym('ab')));
  });

  it('Tab and Escape behave the same Integral-side (commit + blur); Escape adds no follow-up action', () => {
    for (const key of ['Tab', 'Escape']) {
      const { controller, container } = make({ v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } });
      controller.placeCaret(rowc([], 2));
      container.focus();
      let blurCount = 0;
      container.addEventListener('blur', () => blurCount++);
      const before = snap(controller);
      const ev = press(container, key);
      expect(ev.defaultPrevented).toBe(true);
      expect(blurCount).toBe(1);
      expect(snap(controller)).toBe(before); // commit changes nothing by itself; state persists
      expect(document.activeElement).not.toBe(container);
    }
  });
});

describe('session 5 rider — RESOLVED in the consolidated cleanup: the mroot □-index typing fills the index and drops the flag', () => {
  it('typing at an mroot empty index sticks (the flag drops) — no rejection is recorded', () => {
    const seed = { v: 1, root: { type: 'root', radicand: num(5), mroot: true } };
    const { controller, container } = make(seed);
    controller.placeCaret(sl([], 'index')); // the □ index slot
    container.focus();
    const ev = press(container, '5');
    expect(ev.defaultPrevented).toBe(true); // the key is handled
    // the flag-drop fix: the index fills, `mroot: true` drops, the op applies
    expect(j(controller.getEnvelope())).toBe(
      j({ v: 1, root: { type: 'root', radicand: num(5), index: num(5) } }),
    );
    expect(controller.getState().log.length).toBe(1); // one logged unit
    expect(controller.getState().caret).toEqual(tok(['index'], 1));
    expect(controller.getLastRejection()).toBeNull(); // nothing was rejected
    // a later typing key elsewhere still applies cleanly
    controller.placeCaret(tok(['radicand'], 1));
    press(container, '2');
    expect(j(controller.getEnvelope().root)).toBe(j({ type: 'root', radicand: num(52), index: num(5) }));
    expect(controller.getLastRejection()).toBeNull();
  });
});
