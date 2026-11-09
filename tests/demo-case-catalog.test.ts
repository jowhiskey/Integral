// The dev-only visual-test catalog (demo/cases.ts): every seed is a legal state —
// fromJSON accepts every seed envelope, every seed caret resolves in it (and the
// demo's placeCaret path accepts it via moveCaret) — typed instructions replay
// legally through the engine, IDs are unique/stable and the globally first case is
// the empty formula, and the seed data stays dev-only (package exports/files pin +
// no src file references demo/).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromJSON } from '../src/ast/index.js';
import { applyOp, caretResolves, caretResolvesIn, initSession, typeToken } from '../src/engine/index.js';
import { KEYMAP } from '../src/editor/keys.js';
import { CASES, CATEGORIES } from '../demo/cases.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, unknown>;
  files?: string[];
};

describe('demo case catalog — structure and hygiene', () => {
  it('IDs are unique, well-formed (<CATEGORY>-<NN>), and every case’s category is declared', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catKeys = new Set(CATEGORIES.map((c) => c.key));
    for (const c of CASES) {
      expect(c.id).toMatch(new RegExp(`^${c.category}-\\d{2}$`));
      expect(catKeys.has(c.category)).toBe(true);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.stress.length).toBeGreaterThan(0);
    }
  });

  it('every declared category has at least one case', () => {
    for (const cat of CATEGORIES) {
      expect(CASES.some((c) => c.category === cat.key), `category ${cat.key}`).toBe(true);
    }
  });

  it('every case carries rule-ID reference labels pointing at the contract (rework session 1)', () => {
    // References only, NEVER behavior predictions — expected behavior lives in
    // docs/context/interaction.md. Legal refs: T/N/C/D/U/K family IDs,
    // S-scenario IDs, OA-* owner-amendment labels.
    // session 2a extends the OA set with the two additions ruled/fixed during the session:
    // OA-dot-eval (a dotted number evaluates as its value) and OA-mixed (the
    // mixed implicit/explicit multiply-row definition).
    const RULE_PATTERN = /^(T\d\d?|N\d|C\d|D\d|U\d|K\d|S-\d{3}|OA-(digit-glue|juxtaposition|projection|fence|dot-eval|mixed))$/;
    for (const c of CASES) {
      expect(c.rules.length > 0, `${c.id} carries at least one rule ref`).toBe(true);
      for (const rule of c.rules) {
        expect(rule, `${c.id} rule ${JSON.stringify(rule)}`).toMatch(RULE_PATTERN);
      }
    }
  });

  it('the globally FIRST case is the empty starting point (empty formula, caret at start)', () => {
    expect(CASES[0].id).toBe('E-01');
    expect(CASES[0].envelope).toEqual({ v: 1, root: null });
    expect(CASES[0].caret).toEqual({ kind: 'empty' });
  });
});

describe('demo case catalog — seed legality', () => {
  it('fromJSON accepts every seed envelope', () => {
    for (const c of CASES) {
      expect(() => fromJSON(c.envelope), c.id).not.toThrow();
    }
  });

  it('every seed caret resolves in its seed envelope (and placeCaret’s moveCaret accepts it)', () => {
    for (const c of CASES) {
      expect(caretResolvesIn(c.envelope, c.caret), `${c.id} caretResolvesIn`).toBe(true);
      const session = initSession(c.envelope);
      expect(() => applyOp(session, { op: 'moveCaret', to: c.caret }), `${c.id} moveCaret`).not.toThrow();
      expect(caretResolves(session.root, c.caret), `${c.id} caretResolves`).toBe(true);
    }
  });

  it('every typed-from-empty instruction uses keymap chars and replays to a legal state through the engine', () => {
    const instructionCases = CASES.filter((c) => c.keys !== undefined);
    expect(instructionCases.length).toBeGreaterThan(0);
    for (const c of instructionCases) {
      let state = initSession(c.envelope);
      for (const ch of c.keys!) {
        const token = KEYMAP[ch];
        expect(token, `${c.id}: key ${JSON.stringify(ch)} not in KEYMAP`).toBeDefined();
        state = typeToken(state, token!);
      }
      expect(caretResolves(state.root, state.caret), `${c.id} final caret`).toBe(true);
    }
  });
});

describe('demo case catalog — dev-only pin', () => {
  it('package exports/files are unchanged (the seed data stays out of the published package)', () => {
    expect(Object.keys(pkg.exports)).toEqual(['./ast', './engine', './editor']);
    expect(pkg.files).toEqual(['dist']);
  });

  it('no file under src/ references demo/ (the dependency direction is demo → src only)', () => {
    const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
    const stack = [srcRoot];
    const files: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) stack.push(p);
        else if (p.endsWith('.ts') || p.endsWith('.svelte')) files.push(p);
      }
    }
    for (const f of files) {
      expect(readFileSync(f, 'utf8').includes('demo/'), `${f} must not reference demo/`).toBe(false);
    }
  });
});
