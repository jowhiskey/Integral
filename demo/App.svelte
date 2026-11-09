<script lang="ts">
  // Demo case browser (DOM-layer arc session 5 + the demo-refinement interlude):
  // the visual-test catalog from ./cases.ts rendered as a clickable case list
  // grouped by category. Clicking a case entry loads its seed AST + seed caret
  // into the single case editor; clicking the active case again resets to the
  // seed. Cases with a `keys` instruction (typed-from-empty) get a button that
  // types the instruction through the real keyboard path. A separate
  // always-empty editor is the free scratchpad.
  //
  // The testing area around the case editor carries three live readouts (no
  // devtools needed): the stored AST envelope as pretty JSON, the generated
  // MathML as pretty source (right of the JSON panel), and the caret state
  // (kind + position path) under the editor. All three refresh from the
  // controller's onStateChange, which fires on every op AND every caret
  // placement (keystrokes, clicks, arrows, case loads).
  // Dev-only — not part of the published package.
  import { onMount } from 'svelte';
  import { toMathML } from '../src/ast/index.js';
  import { EditorController, IntegralEditor } from '../src/editor/index.js';
  import { envelopeOf, type Caret, type EditingState } from '../src/engine/index.js';
  import { CATEGORIES, CASES, type CatalogCase } from './cases.js';

  let caseContainer: HTMLDivElement | undefined = $state();
  let controller: EditorController | null = null;
  let activeId: string | null = $state(null);
  let caretText = $state('—');
  let jsonText = $state('—');
  let mathmlText = $state('—');

  const activeCase = $derived(CASES.find((c) => c.id === activeId) ?? null);

  /** Citable caret readout: kind + position path (+ slot / row index / token
   *  offset, + the additive boundary flag when armed). */
  function formatCaret(c: Caret): string {
    const path = 'path' in c ? JSON.stringify(c.path) : '[]';
    const at =
      c.kind === 'slot' ? ` .${c.slot}`
      : c.kind === 'row' ? ` #${c.index}`
      : c.kind === 'token' ? ` @${c.index}`
      : '';
    return `${c.kind} ${path}${at}${c.boundary === true ? ' boundary' : ''}`;
  }

  /** Pretty-print the generated MathML string: one tag per line, indented by
   *  depth (text content on its own line). Demo-only source view. */
  function prettyMathml(src: string): string {
    const tokens = src.match(/<[^>]*>|[^<]+/g) ?? [];
    let depth = 0;
    const lines: string[] = [];
    for (const t of tokens) {
      if (t.startsWith('</')) {
        depth = Math.max(0, depth - 1);
        lines.push(`${'  '.repeat(depth)}${t}`);
      } else if (t.startsWith('<')) {
        lines.push(`${'  '.repeat(depth)}${t}`);
        if (!t.endsWith('/>')) depth += 1;
      } else if (t.trim() !== '') {
        lines.push(`${'  '.repeat(depth)}${t.trim()}`);
      }
    }
    return lines.join('\n');
  }

  /** Live readouts from the current engine state: pretty AST JSON, pretty
   *  MathML source, caret state. Wired to onStateChange (fires on ops and on
   *  pure caret placement alike). */
  function refresh(state: EditingState): void {
    caretText = formatCaret(state.caret);
    jsonText = JSON.stringify(envelopeOf(state), null, 2);
    const mathml = toMathML(state.root);
    mathmlText = mathml === '' ? '(empty formula)' : prettyMathml(mathml);
  }

  function loadCase(c: CatalogCase): void {
    if (!caseContainer) return;
    controller?.destroy();
    caseContainer.replaceChildren();
    controller = new EditorController(caseContainer, {
      envelope: c.envelope,
      onStateChange: refresh,
    });
    controller.placeCaret(c.caret); // seed caret applied (validated, never logged)
    activeId = c.id;
    caseContainer.focus();
    refresh(controller.getState());
  }

  /** Type the case's instruction through the real DOM keydown path. */
  function typeKeys(c: CatalogCase): void {
    if (!caseContainer || c.keys === undefined) return;
    caseContainer.focus();
    for (const ch of c.keys) {
      caseContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    }
  }

  onMount(() => {
    if (!caseContainer) return;
    controller = new EditorController(caseContainer, {
      envelope: { v: 1, root: null },
      onStateChange: refresh,
    });
    refresh(controller.getState());
  });

  // test/host accessors (the mounted component exposes these)
  export function getActiveCaseId(): string | null {
    return activeId;
  }
  export function getController(): EditorController | null {
    return controller;
  }
</script>

<div class="browser">
  <div class="browser-head">
    <h2>Case browser — active case: {activeId ?? 'none yet'}</h2>
    <details class="hint">
      <summary>how to use</summary>
      <p>
        Click a case to load its seed (formula + starting caret) into the case editor; click the active case again
        to reset to the seed. Cases with a <code>keys</code> instruction seed the empty formula — use the “type
        instruction” button (or just type) to run it. The panels right of the editor show the live AST JSON and
        MathML source; the caret readout sits under the editor. The scratchpad at the bottom is always free.
      </p>
    </details>
  </div>
  <div class="case-scroll">
    {#each CATEGORIES as cat}
      <section class="cat">
        <h3>{cat.key} — {cat.title}</h3>
        <ul>
          {#each CASES.filter((c) => c.category === cat.key) as c}
            <li>
              <button type="button" data-case-id={c.id} class:active={c.id === activeId} onclick={() => loadCase(c)}>
                {c.id} — {c.label}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</div>

<div class="stage">
  <div class="editor-col">
    <div class="label">case editor — loads the active case’s seed; re-click the active case to reset</div>
    <div id="case-editor" bind:this={caseContainer} class="integral-editor" tabindex="0" role="textbox" aria-label="case editor"></div>
    {#if activeCase?.keys !== undefined}
      <button type="button" data-run-keys onclick={() => activeCase && typeKeys(activeCase)}>
        type instruction `{activeCase.keys}`
      </button>
    {/if}
    <div class="caret-readout" data-caret>caret {caretText}</div>
    {#if activeCase}
      <div class="note">
        <strong>{activeCase.id}</strong> — {activeCase.stress}
        <span class="rules">rules: {activeCase.rules.join(', ')}</span>
      </div>
    {/if}
  </div>
  <div class="panel">
    <div class="label">stored AST envelope — pretty JSON (live)</div>
    <pre class="src" data-json>{jsonText}</pre>
  </div>
  <div class="panel">
    <div class="label">generated MathML — pretty source (live)</div>
    <pre class="src" data-mathml>{mathmlText}</pre>
  </div>
</div>

<div class="scratch">
  <div class="label">scratchpad — always-available empty editor (free edit; the case browser never touches it)</div>
  <IntegralEditor envelope={{ v: 1, root: null }} />
</div>
