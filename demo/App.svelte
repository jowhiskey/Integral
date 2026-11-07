<script lang="ts">
  // Demo case browser (DOM-layer arc session 5): the visual-test catalog from
  // ./cases.ts rendered as a clickable case list grouped by category. Clicking a
  // case entry loads its seed AST + seed caret into the single case editor;
  // clicking the active case again resets to the seed. Cases with a `keys`
  // instruction (typed-from-empty) get a button that types the instruction through
  // the real keyboard path. A separate always-empty editor is the free scratchpad.
  // Dev-only — not part of the published package.
  import { onMount } from 'svelte';
  import { EditorController, IntegralEditor } from '../src/editor/index.js';
  import { envelopeOf } from '../src/engine/index.js';
  import { CATEGORIES, CASES, type CatalogCase } from './cases.js';

  let caseContainer: HTMLDivElement | undefined = $state();
  let controller: EditorController | null = null;
  let activeId: string | null = $state(null);
  let readout = $state({ caret: '—', env: '—' });

  const activeCase = $derived(CASES.find((c) => c.id === activeId) ?? null);

  const showState = (state: { caret: unknown; root: unknown }): void => {
    readout = { caret: JSON.stringify(state.caret), env: JSON.stringify(state.root) };
  };

  function loadCase(c: CatalogCase): void {
    if (!caseContainer) return;
    controller?.destroy();
    caseContainer.replaceChildren();
    controller = new EditorController(caseContainer, {
      envelope: c.envelope,
      onStateChange: (s) => showState({ caret: s.caret, root: envelopeOf(s).root }),
      onCaretChange: (caret) => (readout = { ...readout, caret: JSON.stringify(caret) }),
    });
    controller.placeCaret(c.caret); // seed caret applied (validated, never logged)
    activeId = c.id;
    caseContainer.focus();
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
      onStateChange: (s) => showState({ caret: s.caret, root: envelopeOf(s).root }),
      onCaretChange: (caret) => (readout = { ...readout, caret: JSON.stringify(caret) }),
    });
    showState({ caret: controller.getState().caret, root: envelopeOf(controller.getState()).root });
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
  <h2>Case browser — active case: {activeId ?? 'none yet'}</h2>
  <p class="hint">
    Click a case to load its seed (formula + starting caret) into the case editor below; click the active
    case again to reset to the seed. Cases with a <code>keys</code> instruction seed the empty formula — use
    the “type instruction” button (or just type) to run it. The scratchpad at the bottom is always free.
  </p>
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

<div class="example">
  <div class="label">case editor — loads the active case’s seed; re-click the active case to reset</div>
  <div id="case-editor" bind:this={caseContainer} class="integral-editor" tabindex="0" role="textbox" aria-label="case editor"></div>
  {#if activeCase?.keys !== undefined}
    <button type="button" data-run-keys onclick={() => activeCase && typeKeys(activeCase)}>
      type instruction `{activeCase.keys}`
    </button>
  {/if}
  <div class="readout">caret {readout.caret}\nenv   {readout.env}</div>
  {#if activeCase}
    <div class="note"><strong>{activeCase.id}</strong> — {activeCase.stress}</div>
  {/if}
</div>

<div class="example">
  <div class="label">scratchpad — always-available empty editor (free edit; the case browser never touches it)</div>
  <IntegralEditor envelope={{ v: 1, root: null }} />
</div>
