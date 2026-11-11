<script lang="ts">
  // Demo: the visual-test case browser + the usability-test logger.
  //
  // ONE editor (the case editor below): free typing into an empty document by
  // default; clicking a case in the grid loads that case's content INTO this
  // same editor (content replaced, same on-screen surface — the controller is
  // re-seeded in place, as the case-load pins rely on). No second editor, no
  // scratchpad.
  //
  // The test logger (demo/recorder.ts + demo/logger-core.ts) wraps that editor
  // passively: Record starts a recording whose first entry is the full
  // baseline (AST envelope, caret, caret rect, MathML, all element rects, all
  // whitelisted styles); every user action during recording (keydown, click, case
  // load) appends one unified-diff entry — a field appears only when changed.
  // Capture is KEYDOWN-ONLY: keyup is never captured, and a bare modifier keydown
  // (Shift/Control/Alt/Meta) is no step of its own — its state rides on the next
  // keydown's modifier flags. The panel lists entries; clicking one expands it
  // (the state in effect at that entry: MathML from the most recent entry that
  // changed it, caret from the resolved caret rect) AND, for a loaded recording,
  // restores that step's after-state into the editor (per-channel walk-up via
  // resolveAt); comments pin below the entry. Loading a recording restores its
  // CLOSING state (the last step's after-state) into the editor — editor and
  // panel in sync; Unload clears the loaded recording and resets the editor to
  // the empty formula. The header's one name input is the single name surface:
  // load fills it, editing it renames the loaded record (persisted), and a new
  // record takes the input's content at STOP time (empty input → empty title).
  // Recordings persist in localStorage; export-one/export-all download text-only
  // JSON bug files.
  //
  // Live readouts: a compact caret/rejection line in the logger header, and
  // below the editor the stored AST envelope (pretty JSON) + the generated
  // MathML source — both live from the current engine state. The bottom
  // IME/dead-key keylogger panel is gone (the engine-side standing event log,
  // 2b-2, is untouched — demo/ime-logger.ts remains for direct use).
  //
  // Dev-only — not part of the published package.
  import { onMount } from 'svelte';
  import { fromJSON, toMathML, type Envelope } from '../src/ast/index.js';
  import { buildMathML, EditorController } from '../src/editor/index.js';
  import { caretResolvesIn, envelopeOf, type Caret, type EditingState } from '../src/engine/index.js';
  import { CATEGORIES, CASES, type CatalogCase } from './cases.js';
  import { Recorder, downloadText } from './recorder.js';
  import {
    deriveMechanicalNoop,
    inputSummary,
    resolveAt,
    type StoredRecording,
    type TestEntry,
  } from './logger-core.js';

  let caseContainer: HTMLDivElement | undefined = $state();
  let controller: EditorController | null = null;
  let recorder: Recorder | null = null;
  let activeId: string | null = $state(null);
  /** Compact live line (kept from the old readouts, now inside the logger header). */
  let caretText = $state('—');
  let rejectionText = $state('—');
  /** Live readouts below the editor: the stored AST envelope as pretty JSON
   *  and the generated MathML as pretty source. */
  let jsonText = $state('—');
  let mathmlText = $state('—');

  // ——— logger UI state ———
  let title = $state('');
  let paintOn = $state(false);
  let recordingNow = $state(false);
  let recordings = $state<ReturnType<Recorder['listRecordings']>>([]);
  let openRec: StoredRecording | null = $state(null);
  let openRecId: string | null = $state(null);
  /** The recording shown in the entries list (the live one while recording). */
  let activeRec: StoredRecording | null = $state(null);
  /** Fresh slice of activeRec.entries on every recorder change — the recorder
   *  mutates its arrays in place, and the panel needs new references to
   *  re-render (a same-reference value does not propagate in Svelte 5). */
  let entries: TestEntry[] = $state([]);
  let expanded: number | null = $state(null);
  let previewEl: HTMLDivElement | undefined = $state();
  let drafts = $state<Record<string, string>>({});

  const activeCase = $derived(CASES.find((c) => c.id === activeId) ?? null);
  const activeRecId = $derived(activeRec?.id ?? null);

  /** Re-read the recorder into the panel state (fresh array references). */
  function refreshPanel(): void {
    if (recorder === null) return;
    recordings = recorder.listRecordings();
    // re-read by id when stopped: setComment replaces the stored object, so a held snapshot would go stale
    activeRec = recorder.isRecording()
      ? recorder.currentRecording()
      : openRecId !== null
        ? recorder.getRecording(openRecId)
        : openRec;
    entries = activeRec?.entries.slice() ?? [];
  }

  /** Citable caret readout: kind + position path (+ slot / row index / token offset). */
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

  /** Live readouts from the current engine state (wired to onStateChange):
   * pretty AST JSON, pretty MathML source, caret state, rejection line. */
  function refresh(state: EditingState): void {
    caretText = formatCaret(state.caret);
    jsonText = JSON.stringify(envelopeOf(state), null, 2);
    const mathml = toMathML(state.root);
    mathmlText = mathml === '' ? '(empty formula)' : prettyMathml(mathml);
    const rej = controller?.getLastRejection() ?? null;
    rejectionText = rej === null ? '—' : `${rej.name} [${rej.kind}]: ${rej.message}`;
  }

  /** Re-seed the one editor in place with an envelope + caret — THE restore
   *  path: case loads, recording load (closing state), unload (empty formula),
   *  and step-click restore all go through here. */
  function restoreEditor(envelope: Envelope, caret: Caret): void {
    if (!caseContainer) return;
    controller?.destroy();
    caseContainer.replaceChildren();
    controller = new EditorController(caseContainer, {
      envelope,
      onStateChange: refresh,
    });
    controller.placeCaret(caret); // seed caret applied (validated, never logged)
    refresh(controller.getState());
  }

  /** Restore the editor to the after-state of step `seq` of a recording's log:
   *  per channel, the latest payload at or before that step (resolveAt's
   *  walk-up — caret is always logged, AST/MathML only on change). */
  function restoreRecordingState(entries: readonly TestEntry[], seq: number): void {
    try {
      const res = resolveAt(entries, seq);
      restoreEditor(res.ast as Envelope, res.caret as Caret);
    } catch {
      // unresolvable log (corrupt baseline) — the panel still opens; the editor stays as it was
    }
  }

  function loadCaseInner(c: CatalogCase): void {
    restoreEditor(c.envelope, c.caret);
    activeId = c.id;
    caseContainer?.focus();
  }

  /** Case-grid click: loads the case INTO the one editor; mid-recording this
   *  logs as one normal entry (input = case load). */
  function loadCase(c: CatalogCase): void {
    if (recorder !== null) recorder.recordAction(() => loadCaseInner(c), { kind: 'case-load', caseId: c.id });
    else loadCaseInner(c);
  }

  /** Type the case's instruction through the real DOM keydown path. */
  function typeKeys(c: CatalogCase): void {
    if (!caseContainer || c.keys === undefined) return;
    caseContainer.focus();
    for (const ch of c.keys) {
      caseContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    }
  }

  // ——— recorder wiring ———

  function onRecord(): void {
    if (!recorder) return;
    if (recorder.isRecording()) {
      // the name is read at STOP time: the input's content at this moment,
      // verbatim (empty input → empty title)
      const stopped = recorder.stopRecording(title);
      if (stopped !== null) {
        openRec = stopped;
        openRecId = stopped.id;
      }
      expanded = null;
    } else {
      recorder.setPaint(paintOn);
      recorder.startRecording(title); // live draft only — the final name is read at stop
      openRec = null;
      openRecId = null;
      expanded = null;
    }
    recordingNow = recorder.isRecording();
    refreshPanel();
    // the Record/Stop click moves focus to the button — hand it back to the
    // editor so typing right away is captured (the controller's focus gate)
    caseContainer?.focus();
  }

  function onPaintToggle(): void {
    recorder?.setPaint(paintOn);
  }

  /** Entry click: toggle the review expansion; when a recording is loaded (not
   *  recording — a restore mid-recording would corrupt the live diff chain),
   *  also set the editor to that step's after-state. The editor stays live:
   *  further typing changes the editor only, the recording is untouched. */
  function onEntryClick(seq: number): void {
    expanded = expanded === seq ? null : seq;
    if (!recordingNow && activeRec !== null) {
      restoreRecordingState(activeRec.entries, seq);
      activeId = null;
      caseContainer?.focus();
    }
  }

  // The one name input is the single surface for a record's name — plain
  // Svelte reactivity, no separate rename affordance: while a record is loaded,
  // editing the input renames it (persisted, list updates). Loading fills the
  // input with the record's name (a no-op here); an empty session is an empty
  // input. Keystrokes in the input never become log steps (it lives outside the
  // editor container — the recorder only captures inside it).
  $effect(() => {
    const t = title;
    const id = openRecId;
    if (recorder === null || id === null || recordingNow) return;
    const cur = recorder.getRecording(id);
    if (cur === null || cur.title === t) return;
    recorder.renameRecording(id, t);
    refreshPanel();
  });

  const commentOf = (seq: number): string | undefined => activeRec?.comments[String(seq)];

  function pinComment(seq: number): void {
    if (!recorder || activeRecId === null) return;
    recorder.setComment(activeRecId, seq, drafts[`${activeRecId}:${seq}`] ?? '');
    refreshPanel();
  }

  /** Load a stored recording: the panel shows its steps/comments AND the editor
   *  is restored to the recording's closing state (the last step's after-state)
   *  — editor and panel in sync. Disabled while recording (recording integrity). */
  function openRecording(id: string): void {
    if (!recorder || recorder.isRecording()) return;
    const rec = recorder.getRecording(id);
    if (rec === null) return;
    openRec = rec;
    openRecId = id;
    title = rec.title; // the one name input carries the loaded record's name
    expanded = null;
    if (rec.entries.length > 0) restoreRecordingState(rec.entries, rec.entries.length - 1);
    activeId = null;
    refreshPanel();
    caseContainer?.focus();
  }

  /** Unload the loaded recording: the logger/panel and the name input return to
   *  the empty session and the free editor returns to the empty formula. The
   *  recording itself stays saved in the list. Disabled while recording. */
  function onUnload(): void {
    if (!recorder || recorder.isRecording() || openRecId === null) return;
    openRec = null;
    openRecId = null;
    expanded = null;
    title = ''; // empty session → empty input
    activeId = null;
    restoreEditor({ v: 1, root: null }, { kind: 'empty' });
    refreshPanel();
    caseContainer?.focus();
  }

  function deleteRec(id: string): void {
    if (!recorder) return;
    recorder.deleteRecording(id);
    if (openRecId === id) {
      openRec = null;
      openRecId = null;
      expanded = null;
    }
    refreshPanel();
  }

  function exportOne(id: string): void {
    const text = recorder?.exportOne(id);
    if (text !== null && text !== undefined) downloadText(`${id}.testlog.json`, text);
  }

  function onExportAll(): void {
    if (!recorder) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`integral-testlog-cluster-${stamp}.json`, recorder.exportAll());
  }

  const diffKeys = (e: TestEntry): string[] =>
    Object.keys(e).filter((k) => k !== 'seq' && k !== 't' && k !== 'input' && k !== 'rejection');

  /** Re-render the state in effect at the expanded entry: MathML from the most
   *  recent entry that changed it (via resolveAt), caret drawn from the
   *  resolved caret rect. The preview is styled like the editor container, so
   *  the container-relative rect maps 1:1. */
  $effect(() => {
    const seq = expanded;
    const el = previewEl;
    if (seq === null || el === undefined) return;
    if (entries.length === 0 || seq >= entries.length) {
      el.replaceChildren();
      return;
    }
    const res = resolveAt(entries, seq);
    el.replaceChildren();
    try {
      const root = fromJSON(res.ast);
      const rendered = buildMathML(root, document);
      el.appendChild(rendered.math);
    } catch {
      // unresolvable snapshot — leave the structure pane empty
    }
    if (res.caretRect !== null) {
      const c = document.createElement('div');
      c.className = 'log-caret';
      c.style.left = `${res.caretRect.x}px`;
      c.style.top = `${res.caretRect.y}px`;
      c.style.height = `${res.caretRect.h}px`;
      el.appendChild(c);
    }
  });

  onMount(() => {
    if (!caseContainer) return;
    controller = new EditorController(caseContainer, {
      envelope: { v: 1, root: null },
      onStateChange: refresh,
    });
    refresh(controller.getState());
    // S-106 demo default (session 5): blur-commit ends the editing session
    // and the undo history dies with it — resume the committed envelope in a
    // fresh session (discard). The controller's own blur handler (commit)
    // runs idempotently alongside. The recorder reads the controller through
    // its closure, so it survives the re-creation.
    caseContainer.addEventListener('blur', () => {
      const ctl = controller;
      if (!caseContainer || !ctl) return;
      const committed = ctl.commit();
      const caret = ctl.getState().caret; // blur must not move the caret
      ctl.destroy();
      caseContainer.replaceChildren();
      controller = new EditorController(caseContainer, { envelope: committed, onStateChange: refresh });
      if (caretResolvesIn(committed, caret)) controller.placeCaret(caret); // resume where the caret was
      refresh(controller.getState());
    });
    // The usability-test recorder: capture-phase input capture + per-entry
    // diff logging around the ONE editor above.
    recorder = new Recorder({
      container: caseContainer,
      getController: () => controller,
      onChange: () => refreshPanel(),
    });
    refreshPanel();
  });

  // test/host accessors (the mounted component exposes these)
  export function getActiveCaseId(): string | null {
    return activeId;
  }
  export function getController(): EditorController | null {
    return controller;
  }
  export function getRecorder(): Recorder | null {
    return recorder;
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
        instruction” button (or just type) to run it. The logger panel right of the editor records the session:
        Record, then act in the editor — every key, click, and case load lands as one diff entry; expand an entry to
        re-render the state at that step and pin a comment. Recordings persist in localStorage and export as JSON.
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
    <div class="label">case editor — loads the active case’s seed; re-click the active case to reset; free typing by default</div>
    <div id="case-editor" bind:this={caseContainer} class="integral-editor" tabindex="0" role="textbox" aria-label="case editor"></div>
    {#if activeCase?.keys !== undefined}
      <button type="button" data-run-keys onclick={() => activeCase && typeKeys(activeCase)}>
        type instruction `{activeCase.keys}`
      </button>
    {/if}
    <div class="vocab-ops">
      <span class="label">T9 insertion vocabulary (the palette/suggestion surface):</span>
      <!-- 4b-1 (I-20/I-21): the vocabulary buttons keep the EDITOR focused —
           a button click moves focus to the button and every keydown would
           die at the controller's focus gate ("no key moves the caret"). -->
      <button type="button" data-insert-root onclick={() => { recorder?.recordAction(() => controller?.insertRoot(), { kind: 'click', target: 'button[data-insert-root]' }); caseContainer?.focus(); }}>√ insert</button>
      <button type="button" data-insert-mroot onclick={() => { recorder?.recordAction(() => controller?.insertRoot({ mroot: true }), { kind: 'click', target: 'button[data-insert-mroot]' }); caseContainer?.focus(); }}>ⁿ√ insert</button>
      <button type="button" data-insert-sub onclick={() => { recorder?.recordAction(() => controller?.insertSubscript(), { kind: 'click', target: 'button[data-insert-sub]' }); caseContainer?.focus(); }}>x₍₎ insert</button>
    </div>
    {#if activeCase}
      <div class="note">
        <strong>{activeCase.id}</strong> — {activeCase.stress}
        <span class="rules">rules: {activeCase.rules.join(', ')}</span>
      </div>
    {/if}
    <div class="readouts">
      <div class="readout">
        <div class="label">stored AST envelope — pretty JSON (live)</div>
        <pre class="src" data-json>{jsonText}</pre>
      </div>
      <div class="readout">
        <div class="label">generated MathML — pretty source (live)</div>
        <pre class="src" data-mathml>{mathmlText}</pre>
      </div>
    </div>
  </div>
  <div class="logger-col">
    <div class="logger-head">
      <button type="button" data-record onclick={onRecord}>{recordingNow ? 'Stop' : 'Record'}</button>
      <label class="paint-toggle">
        <input type="checkbox" data-paint-toggle bind:checked={paintOn} onchange={onPaintToggle} />
        paint geometry
      </label>
      <input type="text" data-title bind:value={title} placeholder="recording name" />
    </div>
    <div class="live-line">
      <span class="caret-readout" data-caret>caret {caretText}</span>
      <span class="rejection-readout" data-rejection>rejection {rejectionText}</span>
    </div>
    {#if entries.length > 0}
      <div class="label entries-label">
        {recordingNow ? 'recording' : 'viewing'} ({entries.length} entries — click one to expand{#if !recordingNow && openRecId !== null}, restore that step's state into the editor{/if})
      </div>
      <ol class="entries">
        {#each entries as e (e.seq)}
          <li>
            <button type="button" class="entry" data-entry-seq={e.seq} class:expanded={expanded === e.seq} onclick={() => onEntryClick(e.seq)}>
              #{e.seq} {inputSummary(e.input)}
              {#if e.rejection}<span class="rej">rejected</span>{/if}
              {#if deriveMechanicalNoop(e)}<span class="noop" data-noop={e.seq}>mechanical no-op</span>{/if}
              {#if commentOf(e.seq)}<span class="cmt">comment</span>{/if}
            </button>
            {#if expanded === e.seq}
              <div class="entry-detail" data-entry-detail={e.seq}>
                <div class="d">input: {JSON.stringify(e.input)}</div>
                {#if e.rejection}
                  <div class="d rej">rejection: {e.rejection.name} [{e.rejection.kind}] {e.rejection.message}</div>
                {/if}
                <div class="d">diff: {diffKeys(e).join(', ') === '' ? '(none — nothing changed)' : diffKeys(e).join(', ')}</div>
                <div class="log-preview" bind:this={previewEl}></div>
                <div class="comment-row">
                  <textarea
                    data-comment-input={e.seq}
                    rows="3"
                    bind:value={drafts[`${activeRecId}:${e.seq}`]}
                    placeholder="pin a comment to this exact state…"
                  ></textarea>
                </div>
                <button type="button" class="comment-pin" data-comment-pin={e.seq} onclick={() => pinComment(e.seq)}>pin</button>
                {#if commentOf(e.seq)}
                  <div class="d cmt">pinned: {commentOf(e.seq)}</div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    <button
      type="button"
      class="unload-btn"
      data-unload
      disabled={recordingNow || openRecId === null}
      title={recordingNow ? 'stop the recording first' : openRecId === null ? 'nothing loaded' : 'clear the loaded recording — panel + editor reset to empty'}
      onclick={onUnload}
    >unload</button>
    <div class="rec-head">
      <span class="label rec-label">recordings (localStorage — one recording = one bug)</span>
      <button type="button" data-export-all onclick={onExportAll}>export all</button>
    </div>
    <ul class="recordings">
      {#each recordings as r (r.id)}
        <li data-rec-id={r.id}>
          <button
            type="button"
            class="rec-open"
            data-rec-open={r.id}
            disabled={recordingNow}
            title={recordingNow ? 'stop the recording first' : 'load: panel shows the steps + the editor restores the closing state'}
            onclick={() => openRecording(r.id)}
          >{r.title === '' ? '(no name)' : r.title}</button>
          <span class="meta">{r.createdAt} — {r.entryCount} entries{#if r.commentCount > 0}, {r.commentCount} comments{/if}</span>
          <button type="button" data-rec-export={r.id} onclick={() => exportOne(r.id)}>export</button>
          <button type="button" data-rec-delete={r.id} onclick={() => deleteRec(r.id)}>delete</button>
        </li>
      {/each}
    </ul>
  </div>
</div>
