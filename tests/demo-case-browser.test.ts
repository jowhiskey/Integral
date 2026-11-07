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
import { envelopeOf, initSession, typeToken } from '../src/engine/index.js';
import { KEYMAP } from '../src/editor/keys.js';
import type { EditorController } from '../src/editor/index.js';
import { countNodes } from './editor-support.js';

interface AppExports {
  getActiveCaseId(): string | null;
  getController(): EditorController | null;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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
  await tick(); // let Svelte flush the active-class marker
  const c = CASES.find((k) => k.id === id)!;
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
    // the always-available empty scratchpad editor is present alongside
    expect(target.querySelectorAll('.integral-editor').length).toBe(2);
    await unmount(app as never);
  });

  it('clicking EVERY case entry loads its seeded state; re-clicking after another case resets to the seed', async () => {
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

  it('instruction cases: the run-keys button replays the instruction through the DOM keyboard path to the engine-expected state', async () => {
    const { target, app } = mountApp();
    await tick();
    const instructionCases = CASES.filter((c) => c.keys !== undefined);
    expect(instructionCases.length).toBeGreaterThan(0);
    for (const c of instructionCases) {
      click(caseButton(target, c.id));
      await tick(); // let the run-keys button render for the active instruction case
      const runBtn = target.querySelector('button[data-run-keys]') as HTMLButtonElement | null;
      expect(runBtn, `${c.id} run-keys button`).not.toBeNull();
      click(runBtn!);
      // engine replay of the same instruction
      let expected = initSession(c.envelope);
      for (const ch of c.keys!) expected = typeToken(expected, KEYMAP[ch]!);
      const state = app.getController()!.getState();
      expect(envelopeOf(state), `${c.id} typed envelope`).toEqual(envelopeOf(expected));
      expect(state.caret, `${c.id} typed caret`).toEqual(expected.caret);
    }
    await unmount(app as never);
  });
});
