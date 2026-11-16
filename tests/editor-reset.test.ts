// @vitest-environment jsdom
// EditorController.reset(envelope): in-place reseed from a stored envelope —
// the same controller instance survives, the mount lifecycle does not
// re-fire, invalid envelopes reject loudly through the versioned fromJSON
// gate with the content unchanged, and the internal-state semantics are
// pinned (fresh session: log/redo cleared, the reset itself not undoable,
// mount-equivalent caret, kept vocabulary, transient state discarded,
// omitted envelope = the empty formula).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubRects } from './editor-support.js';
import { ValidationError, ValidationLimitError } from '../src/ast/validation.js';
import type { StaticVocabulary } from '../src/ast/vocabulary.js';
import type { Caret, Path, SlotName } from '../src/engine/index.js';
import { EditorController, type EditorControllerOptions } from '../src/editor/controller.js';

afterEach(() => vi.restoreAllMocks());

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;
const j = (x: unknown): string => JSON.stringify(x);

const nod = (path: Path, side: 'left' | 'right' = 'right'): Caret => ({ kind: 'node', path, side });
const rowc = (path: Path, index: number): Caret => ({ kind: 'row', path, index });
const sl = (path: Path, slot: SlotName): Caret => ({ kind: 'slot', path, slot });

const SEED_A = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };
const SEED_B = { v: 1, root: { type: 'frac', num: num(1), den: num(2) } };
// incomplete tree: the mount caret pends in the first empty station (the den slot)
const SEED_PEND = { v: 1, root: { type: 'frac', num: num(1), den: null } };
// an op row with a fenceless structure at [1]: BS at the row end arms the D5 highlight
const SEED_HL = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), { type: 'frac', num: num(1), den: num(2) }] } };
const FRAC = {
  v: 1,
  root: {
    type: 'frac',
    num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
    den: { type: 'op', op: 'add', args: [sym('c'), sym('d')] },
  },
};

function make(
  envelope: unknown,
  options: Omit<EditorControllerOptions, 'envelope'> = {},
): { controller: EditorController; container: HTMLDivElement } {
  const container = document.createElement('div');
  container.id = 'container';
  document.body.appendChild(container);
  stubRects({ container: { left: 0, top: 0, width: 300, height: 40 } });
  const controller = new EditorController(container, { envelope, ...options });
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

describe('reset: in-place reseed (same instance, mount lifecycle not re-fired)', () => {
  it('content becomes the envelope, onStateChange fires once, the <math> tree is rebuilt in place, and listeners stay live', () => {
    let changes = 0;
    const { controller, container } = make(SEED_A, { onStateChange: () => changes++ });
    controller.apply({ op: 'insert', node: num(7), at: { at: 'row', path: [], index: 2 } });
    expect(changes).toBe(1);
    const caretDiv = container.querySelector('.integral-caret');
    const styleCount = document.head.querySelectorAll('style').length;
    const math1 = controller.getRendered()!.math;
    const fresh = new EditorController(document.createElement('div'), { envelope: SEED_B });

    controller.reset(SEED_B);
    expect(j(controller.getEnvelope())).toBe(j(fresh.getEnvelope())); // content equals the envelope
    expect(changes).toBe(2); // the reset fired onStateChange exactly once
    // in-place re-render: fresh <math> instance, same container, [math, caretDiv] order kept
    const math2 = controller.getRendered()!.math;
    expect(math2).not.toBe(math1);
    expect(math1.isConnected).toBe(false);
    expect(container.contains(math2)).toBe(true);
    expect(container.firstElementChild).toBe(math2);
    // the mount wiring is untouched: same caret div, styles not re-injected
    expect(container.querySelector('.integral-caret')).toBe(caretDiv);
    expect(document.head.querySelectorAll('style').length).toBe(styleCount);
    expect(container.childElementCount).toBe(2);
    // listeners stay live: a focused keydown still edits after the reset
    container.focus();
    press(container, '5');
    expect(controller.getState().log.length).toBe(1);
  });

  it('repeated resets keep exactly one caret div, one style element, and the single tabindex', () => {
    const { controller, container } = make(SEED_A);
    const caretDiv = container.querySelector('.integral-caret');
    const styleCount = document.head.querySelectorAll('style').length;
    controller.reset(SEED_B);
    controller.reset(SEED_PEND);
    controller.reset();
    expect(container.querySelectorAll('.integral-caret').length).toBe(1);
    expect(container.querySelector('.integral-caret')).toBe(caretDiv);
    expect(document.head.querySelectorAll('style').length).toBe(styleCount);
    expect(container.getAttribute('tabindex')).toBe('0');
    expect(container.childElementCount).toBe(2);
  });
});

describe('reset: validation through the versioned envelope path (loud typed rejection, content unchanged)', () => {
  it('unknown-version / corrupted / non-envelope payloads throw ValidationError and change nothing', () => {
    const { controller } = make(SEED_A);
    controller.apply({ op: 'insert', node: num(7), at: { at: 'row', path: [], index: 2 } });
    const stateBefore = controller.getState();
    const envBefore = j(controller.getEnvelope());
    const bad: [string, unknown][] = [
      ['unknown version', { v: 2, root: null }],
      ['missing version', { root: null }],
      ['unknown node tag', { v: 1, root: { type: 'bogus' } }],
      ['string payload', 'not an envelope'],
      ['non-finite number', { v: 1, root: { type: 'num', value: Number.NaN } }],
    ];
    for (const [label, payload] of bad) {
      let caught: unknown;
      try {
        controller.reset(payload);
      } catch (e) {
        caught = e;
      }
      expect(caught, label).toBeInstanceOf(ValidationError);
      expect(controller.getState(), label).toBe(stateBefore); // the live state object is untouched
      expect(j(controller.getEnvelope()), label).toBe(envBefore); // content unchanged — nothing half-applied
    }
  });

  it('a budget overrun throws ValidationLimitError (a ValidationError subclass), still with content unchanged', () => {
    const { controller } = make(SEED_A);
    const envBefore = j(controller.getEnvelope());
    const fat = { v: 1, root: { type: 'op', op: 'add', args: Array.from({ length: 501 }, () => num(1)) } };
    let caught: unknown;
    try {
      controller.reset(fat);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationLimitError);
    expect(caught).toBeInstanceOf(ValidationError);
    expect(j(controller.getEnvelope())).toBe(envBefore);
    // a valid envelope still resets cleanly afterwards
    controller.reset(SEED_B);
    expect(j(controller.getEnvelope().root)).toBe(j(SEED_B.root));
  });
});

describe('reset: pinned internal-state semantics', () => {
  it('clears the undo log and the redo list, and the reset itself is not undoable (stale before-snapshots address the replaced document)', () => {
    const { controller } = make({ v: 1, root: null });
    controller.apply({ op: 'insert', node: num(5), at: { at: 'root' } });
    controller.undo(); // log 0 / redo 1
    controller.apply({ op: 'insert', node: sym('a'), at: { at: 'root' } }); // log 1 / redo cleared by the new op
    expect(controller.getState().log.length).toBe(1);
    controller.reset(SEED_B);
    expect(controller.getState().log).toEqual([]);
    expect(controller.getState().redo).toEqual([]);
    controller.undo(); // defined no-op — the reset is not a log step
    expect(j(controller.getEnvelope())).toBe(j({ v: 1, root: SEED_B.root }));
    expect(controller.getState().log.length).toBe(0);
    controller.redo(); // nothing to redo either
    expect(j(controller.getEnvelope())).toBe(j({ v: 1, root: SEED_B.root }));
  });

  it('the caret after reset is the mount-equivalent initial caret of the new document (pend and complete shapes)', () => {
    const { controller } = make(SEED_A);
    controller.reset(SEED_PEND);
    expect(controller.getState().caret).toEqual(sl([], 'den')); // pends in the empty den slot
    const freshPend = new EditorController(document.createElement('div'), { envelope: SEED_PEND });
    expect(controller.getState().caret).toEqual(freshPend.getState().caret);
    controller.reset(SEED_B);
    expect(controller.getState().caret).toEqual(nod([], 'right')); // complete structure: its after-station
    const freshB = new EditorController(document.createElement('div'), { envelope: SEED_B });
    expect(controller.getState().caret).toEqual(freshB.getState().caret);
  });

  it('keeps the session vocabulary (the same reference) across the reset', () => {
    const vocabulary: StaticVocabulary = { constants: ['pi'], units: ['mm'], functions: ['sin'] };
    const { controller } = make(SEED_A, { vocabulary });
    controller.reset(SEED_B);
    expect(controller.getState().vocabulary).toBe(vocabulary);
  });

  it('discards transient controller state with the replaced session (vertical memory, D5 highlight, pending dead-key, rejection report)', () => {
    // vertical memory: a down-press leaving the num region writes a store
    const { controller, container } = make(FRAC);
    controller.placeCaret(rowc(['num'], 0));
    container.focus();
    press(container, 'ArrowDown');
    expect(controller.getVerticalMemory().size).toBeGreaterThan(0);
    controller.reset(SEED_A);
    expect(controller.getVerticalMemory().size).toBe(0);

    // D5 highlight: BS at the row end before the fenceless frac arms the paint
    const hl = make(SEED_HL);
    hl.controller.placeCaret(rowc([], 2));
    hl.container.focus();
    press(hl.container, 'Backspace');
    expect(hl.container.querySelector('.integral-highlight')).not.toBeNull();
    hl.controller.reset(SEED_A);
    expect(hl.container.querySelector('.integral-highlight')).toBeNull(); // the armed highlight is gone

    // pending dead-key: a Dead press arms the pending power; after reset the next key types plainly
    const dk = make({ v: 1, root: null });
    dk.container.focus();
    press(dk.container, 'Dead', { code: 'Backquote' });
    dk.controller.reset(); // empty formula
    press(dk.container, '5');
    expect(j(dk.controller.getEnvelope().root)).toBe(j(num(5))); // a surviving pending would have diverted this into a pow
    expect(dk.controller.getLastRejection()).toBeNull(); // the rejection report is session-scoped, cleared
  });

  it('omitted envelope resets to the empty formula, mirroring mount', () => {
    const { controller } = make(SEED_A);
    controller.reset();
    expect(j(controller.getEnvelope())).toBe('{"v":1,"root":null}');
    expect(controller.getState().caret).toEqual({ kind: 'empty' });
    expect(controller.getState().log).toEqual([]);
  });
});
