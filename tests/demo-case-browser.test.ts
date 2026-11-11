// @vitest-environment jsdom
// The demo case browser is really wired: mounting demo/App.svelte renders one
// clickable entry per catalog case grouped by category; clicking EVERY case’s
// entry loads the seeded state into the case editor — asserted on the controller’s
// engine state (envelope + caret) AND the rendered MathML (one uid element per AST
// node) — and re-clicking after another case was loaded resets to the seed.
// Instruction cases additionally replay their key sequence through the DOM keyboard
// path to exactly the state the engine produces for the same keys.

import { describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';

import App from '../demo/App.svelte';
import { CASES, CATEGORIES } from '../demo/cases.js';
import { envelopeOf, initSession, settleUnits, typeToken } from '../src/engine/index.js';
import { KEYMAP } from '../src/editor/keys.js';
import type { EditorController } from '../src/editor/index.js';
import { countNodes } from './editor-support.js';

interface AppExports {
  getActiveCaseId(): string | null;
  getController(): EditorController | null;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Poll (with a tick between tries) until `cond` holds — Svelte flushes are
 *  macro-task based, and under full-suite worker load a single tick can fire
 *  before the flush lands (the 4b-1 full-suite flake, green standalone).
 *  Exhausting the tries falls through to the real assertions, which then
 *  report the genuine failure. */
async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (cond()) return; // the loads are synchronous — usually no wait at all
    await tick();
  }
}

function mountApp(): { target: HTMLDivElement; app: AppExports } {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(App, { target }) as unknown as AppExports;
  return { target, app };
}

const caseButton = (target: HTMLDivElement, id: string): HTMLButtonElement => {
  const btn = target.querySelector(`button[data-case-id="${id}"]`);
  expect(btn, `entry for ${id}`).not.toBeNull();
  return btn as HTMLButtonElement;
};

const click = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

/** Assert the case editor currently shows exactly the seeded state of case c. */
async function expectSeededState(target: HTMLDivElement, app: AppExports, id: string): Promise<void> {
  const c = CASES.find((k) => k.id === id)!;
  // wait until the load actually landed (active id + engine state), then assert
  await waitFor(() => {
    if (app.getActiveCaseId() !== id) return false;
    const ctl = app.getController();
    if (ctl === null) return false;
    const s = ctl.getState();
    return JSON.stringify(envelopeOf(s)) === JSON.stringify(c.envelope) && JSON.stringify(s.caret) === JSON.stringify(c.caret);
  });
  await tick(); // let Svelte flush the active-class marker
  expect(app.getActiveCaseId()).toBe(id);
  const ctl = app.getController();
  expect(ctl).not.toBeNull();
  const state = ctl!.getState();
  expect(envelopeOf(state), `${id} envelope`).toEqual(c.envelope);
  expect(state.caret, `${id} caret`).toEqual(c.caret);
  // rendered MathML, not just DOM presence: one uid element per AST node of the seed
  const math = target.querySelector('#case-editor math');
  expect(math, `${id} rendered <math>`).not.toBeNull();
  expect(math!.querySelectorAll('[id]').length, `${id} uid count`).toBe(countNodes(c.envelope.root));
  // the active entry is marked
  expect(caseButton(target, id).classList.contains('active')).toBe(true);
}

describe('demo case browser', () => {
  it('renders one clickable entry per catalog case, grouped under every declared category', async () => {
    const { target, app } = mountApp();
    await tick();
    const buttons = [...target.querySelectorAll('button[data-case-id]')] as HTMLButtonElement[];
    expect(buttons.length).toBe(CASES.length);
    expect(new Set(buttons.map((b) => b.getAttribute('data-case-id'))).size).toBe(CASES.length);
    for (const cat of CATEGORIES) {
      const section = [...target.querySelectorAll('.browser .cat')].find((s) =>
        s.querySelector('h3')?.textContent?.startsWith(`${cat.key} —`),
      );
      expect(section, `category section ${cat.key}`).toBeDefined();
      const inSection = [...(section as HTMLElement).querySelectorAll('button[data-case-id]')].length;
      expect(inSection).toBe(CASES.filter((c) => c.category === cat.key).length);
    }
    // the single case editor is the demo's only editing surface
    expect(target.querySelectorAll('.integral-editor').length).toBe(1);
    await unmount(app as never);
  });

  // long test by design (every catalog case, twice): explicit timeout so a
  // loaded worker doesn't read as a failure (the 4b-1 full-suite flake)
  it('clicking EVERY case entry loads its seeded state; re-clicking after another case resets to the seed', { timeout: 30000 }, async () => {
    const { target, app } = mountApp();
    await tick();
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      click(caseButton(target, c.id));
      await expectSeededState(target, app, c.id);
      // load a different case in between, then re-click the original: reset to seed
      const other = CASES[(i + 1) % CASES.length];
      click(caseButton(target, other.id));
      await expectSeededState(target, app, other.id);
      click(caseButton(target, c.id));
      await expectSeededState(target, app, c.id);
    }
    await unmount(app as never);
  });

  it('S-106 demo default (session 5): blur-commit discards the undo history — the committed envelope resumes in a fresh session', async () => {
    const { target, app } = mountApp();
    await tick();
    click(caseButton(target, 'U-04')); // instruction case, keys 'xyz'
    await tick();
    const runBtn = target.querySelector('button[data-run-keys]') as HTMLButtonElement | null;
    expect(runBtn, 'run-keys button').not.toBeNull();
    click(runBtn!);
    const ctl1 = app.getController()!;
    expect(ctl1.getState().log.length).toBe(1); // U1: the typed `xyz` run coalesced into ONE unit
    const committed = JSON.parse(JSON.stringify(envelopeOf(ctl1.getState()))) as unknown;
    const editor = target.querySelector('#case-editor') as HTMLElement;
    editor.dispatchEvent(new FocusEvent('blur', { bubbles: false })); // K2/K3-style blur-commit
    await tick();
    const ctl2 = app.getController()!;
    expect(ctl2).not.toBe(ctl1); // a fresh session was resumed from the committed envelope
    expect(envelopeOf(ctl2.getState())).toEqual(committed); // the formula persists
    expect(ctl2.getState().log.length).toBe(0); // the undo history died with the session (discard default)
    await unmount(app as never);
  });

  it('blur-resume preserves the caret (clicking outside the editor must not move it)', async () => {
    const { target, app } = mountApp();
    await tick();
    click(caseButton(target, 'K-16')); // a + b, seed caret at the row end
    await tick();
    const before = app.getController()!;
    const caret = { kind: 'token', path: [0], index: 0 } as const; // mid-formula, NOT the end
    before.placeCaret(caret);
    const editor = target.querySelector('#case-editor') as HTMLElement;
    editor.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    await tick();
    const after = app.getController()!;
    expect(after).not.toBe(before);
    expect(after.getState().caret).toEqual(caret); // the caret stays where it was
    expect(envelopeOf(after.getState())).toEqual(CASES.find((c) => c.id === 'K-16')!.envelope); // formula intact
    expect(after.getState().log.length).toBe(0); // history discarded
    await unmount(app as never);
  });

  it('instruction cases: the run-keys button replays the instruction through the DOM keyboard path to the engine-expected state', async () => {
    const { target, app } = mountApp();
    await tick();
    const instructionCases = CASES.filter((c) => c.keys !== undefined);
    expect(instructionCases.length).toBeGreaterThan(0);
    for (const c of instructionCases) {
      click(caseButton(target, c.id));
      // let the run-keys button render for the active instruction case (poll —
      // full-suite worker load can delay the flush past a single tick)
      await waitFor(() => target.querySelector('button[data-run-keys]') !== null);
      const runBtn = target.querySelector('button[data-run-keys]') as HTMLButtonElement | null;
      expect(runBtn, `${c.id} run-keys button`).not.toBeNull();
      click(runBtn!);
      await waitFor(() => {
        const s = app.getController()?.getState();
        return s !== undefined && app.getActiveCaseId() === c.id;
      });
      // engine replay of the same instruction + the controller-side leave
      // settle (rework 2b-2: the DOM path fires the S-051 conversion on the
      // leave keys BEFORE the key acts — letters never leave, every other
      // key does)
      let expected = initSession(c.envelope);
      for (const ch of c.keys!) {
        const token = KEYMAP[ch]!;
        const isLetter = token !== undefined && token.t === 'leaf' && token.node.type === 'sym' && ch.length === 1;
        if (!isLetter) expected = settleUnits(expected);
        expected = typeToken(expected, token!);
      }
      const state = app.getController()!.getState();
      expect(envelopeOf(state), `${c.id} typed envelope`).toEqual(envelopeOf(expected));
      expect(state.caret, `${c.id} typed caret`).toEqual(expected.caret);
    }
    await unmount(app as never);
  });
});
