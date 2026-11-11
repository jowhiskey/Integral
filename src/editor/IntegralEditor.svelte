<script lang="ts">
  // IntegralEditor — the Svelte 5 wrapper around the editor: a focusable container
  // whose DOM is wired by EditorController (full MathML rebuild per tree change,
  // overlay caret, click placement, keyboard input: typing, arrows with vertical
  // positional memory, undo/redo).
  import { onMount } from 'svelte';
  import { EditorController } from './controller.js';
  import { envelopeOf } from '../engine/index.js';
  import type { EditorProps } from './component-types.js';

  let { envelope, vocabulary, onchange, oncaret }: EditorProps = $props();

  let container: HTMLDivElement | undefined = $state();

  onMount(() => {
    if (!container) return;
    new EditorController(container, {
      envelope,
      vocabulary,
      onStateChange: (state) => onchange?.(envelopeOf(state)),
      onCaretChange: (caret) => oncaret?.(caret),
    });
    container.focus();
  });
</script>

<div
  bind:this={container}
  class="integral-editor"
  tabindex="0"
  role="textbox"
  aria-label="Math formula editor"
></div>

<style>
  .integral-editor {
    position: relative;
    display: inline-block;
    user-select: none;
    outline: none;
    padding: 0.25em 0.5em;
    cursor: text;
  }
  .integral-editor :global(math) {
    font-size: 1.4em;
  }
</style>
