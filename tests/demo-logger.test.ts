// @vitest-environment jsdom
// The demo usability-test logger (demo/recorder.ts + demo/logger-core.ts wired
// into demo/App.svelte): the recording state machine (start/stop, full baseline,
// one entry per action), the unified diff rule on live entries, the derived
// mechanical no-op flag (with injected rect values — jsdom has no layout), the
// last-known-value resolution, persistence across a remount, export
// serialization, the review panel interactions, the style whitelist, the
// element-level diff, and the I-22 dogfood (the twin step flagged).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

import App from '../demo/App.svelte';
import { STORAGE_KEY, elementKeys, type Recorder } from '../demo/recorder.js';
import {
  STYLE_WHITELIST,
  deriveMechanicalNoop,
  parseLogFile,
  parseStorage,
  resolveAt,
  type Rect,
  type TestEntry,
} from '../demo/logger-core.js';
import { applyOp, initSession, settleUnits, typeToken, envelopeOf } from '../src/engine/index.js';
import { KEYMAP } from '../src/editor/keys.js';
import type { EditorController } from '../src/editor/index.js';
import { stubRects } from './editor-support.js';

interface AppExports {
  getActiveCaseId(): string | null;
  getController(): EditorController | null;
  getRecorder(): Recorder | null;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (cond()) return;
    await tick();
  }
}

function mountApp(): { target: HTMLDivElement; app: AppExports } {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(App, { target }) as unknown as AppExports;
  return { target, app };
}

const click = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const press = (editor: HTMLElement, key: string): void => {
  editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

const editorOf = (target: HTMLDivElement): HTMLElement => target.querySelector('#case-editor') as HTMLElement;

function startRecording(target: HTMLDivElement, title = 'test bug'): void {
  const ti = target.querySelector('input[data-title]') as HTMLInputElement;
  ti.value = title;
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  click(target.querySelector('button[data-record]') as HTMLButtonElement);
}

const stopRecording = (target: HTMLDivElement): void => {
  click(target.querySelector('button[data-record]') as HTMLButtonElement);
};

const headerKeys = (e: TestEntry): string[] => Object.keys(e).filter((k) => !['seq', 't', 'input', 'rejection'].includes(k));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('test logger — recording state machine, baseline, per-action entries', () => {
  it('Record → full baseline entry (seq 0); every key → one diff entry; Stop persists to localStorage', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    expect(rec.isRecording()).toBe(false);
    startRecording(target, 'baseline bug');
    expect(rec.isRecording()).toBe(true);
    const live = rec.currentRecording()!;
    expect(live.title).toBe('baseline bug');
    expect(live.entries.length).toBe(1);
    const base = live.entries[0];
    expect(base.seq).toBe(0);
    expect(base.input).toEqual({ kind: 'record-start' });
    // the baseline carries EVERY field in full
    expect(base.ast).toEqual({ v: 1, root: null });
    expect(base.mathml).toBe('');
    expect(base.caret).toEqual({ kind: 'empty' });
    expect(base.caretRect).toEqual({ x: 0, y: 0, w: 2, h: 0 }); // jsdom zero layout
    expect(base.rects).toHaveProperty('math');
    expect(Object.keys(base.styles!.math as Record<string, string>).sort()).toEqual([...STYLE_WHITELIST].sort());

    press(editor, '5');
    expect(live.entries.length).toBe(2); // synchronous flush per input event
    const e1 = live.entries[1];
    expect(e1.input).toMatchObject({ kind: 'key', type: 'keydown', key: '5' });
    expect(e1.ast).toEqual({ v: 1, root: { type: 'num', value: 5 } });
    expect(e1.mathml).toContain('<mn>5</mn>');
    expect(e1.caret).toEqual({ kind: 'token', path: [], index: 1 });
    expect(e1.rects).toHaveProperty('[]'); // the new element appeared
    expect(headerKeys(e1)).toContain('ast');

    press(editor, '0');
    const e2 = live.entries[2];
    expect(e2.ast).toEqual({ v: 1, root: { type: 'num', value: 50 } });
    expect(e2.rects).toBeUndefined(); // same element keys, zero rects — unchanged → absent
    expect(e2.styles).toBeUndefined();
    expect(e2.caretRect).toBeUndefined();

    stopRecording(target);
    expect(rec.isRecording()).toBe(false);
    const summaries = rec.listRecordings();
    expect(summaries.length).toBe(1);
    expect(summaries[0].entryCount).toBe(3);
    // persisted — and the STORED entries carry no derived flag
    const raw = localStorage.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain('mechanicalNoop');
    const stored = parseStorage(raw);
    expect(stored.recordings.length).toBe(1);
    expect(stored.recordings[0].entries.length).toBe(3);
    expect(stored.recordings[0].title).toBe('baseline bug');
    await unmount(app as never);
  });

  it('diff rule on live entries: unchanged absent; a silent no-op key → header-only entry; a case load mid-recording → one entry', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target);
    press(editor, 'ArrowLeft'); // formula-end no-op on the empty formula
    let entries = rec.currentRecording()!.entries;
    expect(entries.length).toBe(2);
    expect(headerKeys(entries[1])).toEqual([]); // header only — nothing changed
    expect(entries[1].rejection).toBeUndefined(); // EngineError-class silent no-ops carry no classified rejection

    click(target.querySelector('button[data-case-id="K-16"]') as HTMLButtonElement);
    entries = rec.currentRecording()!.entries;
    expect(entries.length).toBe(3); // the case load is ONE normal entry
    const cl = entries[2];
    expect(cl.input).toEqual({ kind: 'case-load', caseId: 'K-16' });
    expect(cl.ast).toEqual({ v: 1, root: { type: 'op', op: 'add', args: [{ type: 'sym', name: 'a' }, { type: 'sym', name: 'b' }] } });
    expect(cl.mathml).toContain('<mi>a</mi>');
    expect(cl.caret).toEqual({ kind: 'row', path: [], index: 2 });

    press(editor, 'ArrowLeft'); // caret-only move (jsdom rects zero → no caret-rect diff)
    entries = rec.currentRecording()!.entries;
    const mv = entries[3];
    expect(headerKeys(mv)).toEqual(['caret']);
    expect(deriveMechanicalNoop(mv)).toBe(true);
    await unmount(app as never);
  });

  it('rejection header: a classified rejection (getLastRejection-class) on a no-change typing key → header + rejection only', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target);
    press(editor, '5');
    press(editor, '.'); // 5. — a real change
    // stub the controller's rejection readout (the live ValidationError path was
    // resolved in the cleanup session — the wiring is what this pins)
    const ctl = app.getController()!;
    const original = ctl.getLastRejection.bind(ctl);
    ctl.getLastRejection = () => ({ kind: 'validation', name: 'ValidationError', message: 'simulated gate rejection', token: undefined });
    press(editor, '.'); // second dot: a silent no-op typing key
    ctl.getLastRejection = original;
    const entries = rec.currentRecording()!.entries;
    const rej = entries[3];
    expect(rej.input).toMatchObject({ kind: 'key', key: '.' });
    expect(headerKeys(rej)).toEqual([]); // changed nothing
    expect(rej.rejection).toEqual({ kind: 'validation', name: 'ValidationError', message: 'simulated gate rejection' });
    await unmount(app as never);
  });

  it('click capture: a click inside the editor logs one click entry; the standing IME log records clicks too', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target);
    press(editor, '5');
    const mn = editor.querySelector('math [id]') as Element; // the num's uid element
    click(mn as unknown as HTMLElement);
    const entries = rec.currentRecording()!.entries;
    expect(entries.length).toBe(3);
    const ce = entries[2];
    expect(ce.input.kind).toBe('click');
    expect((ce.input as { target: string }).target).toBe('[]'); // resolved to the stable path key
    await waitFor(() => (target.querySelector('[data-ime-lines]')?.textContent ?? '').includes('click'));
    expect(target.querySelector('[data-ime-lines]')!.textContent).toContain('click');
    await unmount(app as never);
  });

  it('vocabulary button mid-recording logs exactly one entry (input = the button click)', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target);
    click(target.querySelector('button[data-insert-root]') as HTMLButtonElement);
    const entries = rec.currentRecording()!.entries;
    expect(entries.length).toBe(2);
    expect(entries[1].input).toEqual({ kind: 'click', target: 'button[data-insert-root]' });
    expect((entries[1].ast as { root: { type: string } }).root.type).toBe('root');
    await unmount(app as never);
  });
});

describe('test logger — I-22 dogfood (the twin step flagged as a mechanical no-op candidate)', () => {
  it('record `50mm` + `x` + ←←←←: the seam twin (sym@0 then num@2) is caret-only and flagged in the export', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target, 'I-22 twin');
    for (const ch of ['5', '0', 'm', 'm', 'x']) press(editor, ch);
    for (let i = 0; i < 4; i += 1) press(editor, 'ArrowLeft');
    const live = rec.currentRecording()!;
    const entries = live.entries;
    expect(entries.length).toBe(10); // baseline + 5 keys + 4 arrows
    expect(entries.map((e) => e.input.kind)).toEqual(['record-start', 'key', 'key', 'key', 'key', 'key', 'key', 'key', 'key', 'key']);
    // the x produced the implicit pair 50·mmx
    expect(entries[5].ast).toEqual({
      v: 1,
      root: { type: 'op', op: 'multiply', args: [{ type: 'num', value: 50 }, { type: 'sym', name: 'mmx' }], implicit: true },
    });
    // engine replay of the same keys+arrows — the recorded carets match byte-exactly
    let expected = initSession({ v: 1, root: null });
    for (const ch of ['5', '0', 'm', 'm', 'x']) {
      const token = KEYMAP[ch]!;
      const isLetter = token.t === 'leaf' && token.node.type === 'sym';
      if (!isLetter) expected = settleUnits(expected);
      expected = typeToken(expected, token);
    }
    expect(entries[5].caret).toEqual(expected.caret);
    for (let i = 6; i < 10; i += 1) {
      expected = applyOp(expected, { op: 'move', dir: 'left' });
      expect(entries[i].caret).toEqual(expected.caret);
    }
    // the twin: sym@0 then num@2 — two caret-only entries
    const twinA = entries[8];
    const twinB = entries[9];
    expect(twinA.caret).toEqual({ kind: 'token', path: [1], index: 0 }); // sym@0
    expect(twinB.caret).toEqual({ kind: 'token', path: [0], index: 2 }); // num@2
    expect(headerKeys(twinA)).toEqual(['caret']);
    expect(headerKeys(twinB)).toEqual(['caret']);
    expect(deriveMechanicalNoop(twinA)).toBe(true);
    expect(deriveMechanicalNoop(twinB)).toBe(true); // jsdom zero rects → no caret-rect diff → flagged
    // the exported bug file shows the twin flagged (derived at export, not stored)
    const file = parseLogFile(rec.exportOne(live.id)!);
    const exported = file.entries as Array<Record<string, unknown>>;
    expect(exported[8].mechanicalNoop).toBe(true);
    expect(exported[9].mechanicalNoop).toBe(true);
    expect(exported[9].caret).toEqual({ kind: 'token', path: [0], index: 2 });
    expect(exported[0].mechanicalNoop).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('mechanicalNoop');
    await unmount(app as never);
  });
});

describe('test logger — the no-op flag with INJECTED rect values (pure derivation over real captured entries)', () => {
  it('zero rects (jsdom default): the caret-only arrow entry is flagged', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    press(editor, '5'); // build `5` before recording
    const rec = app.getRecorder()!;
    startRecording(target);
    press(editor, 'ArrowLeft'); // token@1 → token@0, rects all zero → caretRect unchanged
    const mv = rec.currentRecording()!.entries[1];
    expect(mv.caret).toEqual({ kind: 'token', path: [], index: 0 });
    expect(mv.caretRect).toBeUndefined();
    expect(deriveMechanicalNoop(mv)).toBe(true);
    await unmount(app as never);
  });

  it('injected rects: the same arrow move with a real caret-rect change is NOT flagged', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    press(editor, '5');
    const stub = stubRects({ 'case-editor': { left: 0, top: 0, width: 300, height: 40 } });
    stub.setMath({ left: 0, top: 0, width: 100, height: 20 });
    stub.syncPath(app.getController()!.getRendered()!, { '[]': { left: 0, top: 0, width: 10, height: 20 } });
    const rec = app.getRecorder()!;
    startRecording(target);
    const base = rec.currentRecording()!.entries[0];
    expect(base.caretRect).toEqual({ x: 10, y: 0, w: 2, h: 20 }); // token@1 over a 10px extent
    expect(base.rects!['[]']).toEqual({ x: 0, y: 0, w: 10, h: 20 });
    press(editor, 'ArrowLeft');
    const mv = rec.currentRecording()!.entries[1];
    expect(mv.caret).toEqual({ kind: 'token', path: [], index: 0 });
    expect(mv.caretRect).toEqual({ x: 0, y: 0, w: 2, h: 20 }); // the injected rect DID change
    expect(deriveMechanicalNoop(mv)).toBe(false); // caret-rect diff present → not a pure caret-only entry
    await unmount(app as never);
  });
});

describe('test logger — resolveAt (state in effect at entry N) on a live recording', () => {
  it('last-known-value per field, skipping entries that change nothing', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target);
    for (const ch of ['5', '0', 'm', 'm', 'x']) press(editor, ch);
    press(editor, 'ArrowLeft'); // no-change? no — moves; then a true no-op:
    press(editor, 'ArrowLeft');
    const entries = rec.currentRecording()!.entries;
    const n = entries.length - 1;
    const res = resolveAt(entries, n);
    expect(res.caret).toEqual(entries[n].caret); // the last caret change
    expect(res.ast).toEqual(entries[5].ast); // look-back over the caret-only entries to the x entry
    expect(res.mathml).toBe(entries[5].mathml);
    expect(res.rects).toHaveProperty('[]'); // cumulative from the baseline
    // a header-only/no-change entry resolves to exactly the previous state
    const resMid = resolveAt(entries, 6);
    expect(resMid.caret).toEqual(entries[6].caret);
    expect(resMid.ast).toEqual(entries[5].ast);
    await unmount(app as never);
  });
});

describe('test logger — persistence across a remount + export serialization', () => {
  it('recordings persist in localStorage across reloads (remount); comments persist; export-one/export-all are schema-stable JSON', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target, 'persist me');
    press(editor, '5');
    press(editor, '0');
    const liveId = rec.currentRecording()!.id;
    rec.setComment(liveId, 1, 'the 5 landed here');
    stopRecording(target);
    await unmount(app as never);

    // "reload": a fresh mount in the same document — localStorage survives
    const second = mountApp();
    await tick();
    const rec2 = second.app.getRecorder()!;
    const summaries = rec2.listRecordings();
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe(liveId);
    expect(summaries[0].entryCount).toBe(3);
    expect(summaries[0].commentCount).toBe(1);
    const loaded = rec2.getRecording(liveId)!;
    expect(loaded.entries.length).toBe(3);
    expect(loaded.comments['1']).toBe('the 5 landed here');
    // the recordings list rendered
    expect(second.target.querySelectorAll('li[data-rec-id]').length).toBe(1);

    // export-one: the bug file
    const bug = parseLogFile(rec2.exportOne(liveId)!);
    expect(bug.kind).toBe('bug');
    expect(bug.title).toBe('persist me');
    const bugEntries = bug.entries as Array<Record<string, unknown>>;
    expect(bugEntries.length).toBe(3);
    expect(bugEntries[1].comment).toBe('the 5 landed here');
    expect(typeof bugEntries[1].mechanicalNoop).toBe('boolean');
    // export-all: the cluster file
    const cluster = parseLogFile(rec2.exportAll());
    expect(cluster.kind).toBe('cluster');
    expect((cluster.recordings as unknown[]).length).toBe(1);
    // schema-stable parse rejects foreign files
    expect(() => parseLogFile('{"format":"nope","version":1}')).toThrow();
    await unmount(second.app as never);
  });
});

describe('test logger — review panel interactions', () => {
  it('expand an entry → state re-rendered via look-back (MathML + caret), comment attach, no-op badge, paint toggle', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    startRecording(target, 'panel bug');
    press(editor, '5');
    press(editor, '0');
    press(editor, 'ArrowLeft'); // caret-only → flagged
    stopRecording(target);
    await tick();
    const id = rec.listRecordings()[0].id;

    // entries listed
    const rows = target.querySelectorAll('button[data-entry-seq]');
    expect(rows.length).toBe(4); // baseline + 5 + 0 + arrow
    // the no-op badge on the caret-only arrow entry
    expect(target.querySelector('button[data-entry-seq="3"] [data-noop="3"]')).not.toBeNull();
    expect(target.querySelector('button[data-entry-seq="1"] [data-noop]')).toBeNull();

    // expand entry 2 → live re-render of the state in effect there
    click(target.querySelector('button[data-entry-seq="2"]') as HTMLButtonElement);
    await waitFor(() => target.querySelector('[data-entry-detail="2"]') !== null);
    const detail = target.querySelector('[data-entry-detail="2"]') as HTMLElement;
    expect(detail.textContent).toContain('caret');
    const previewMath = detail.querySelector('.log-preview math');
    expect(previewMath).not.toBeNull();
    expect(previewMath!.querySelector('mn')!.textContent).toBe('50'); // MathML from the most recent change
    expect(detail.querySelector('.log-preview .log-caret')).not.toBeNull(); // caret from the resolved rect

    // attach a comment to the expanded entry (after recording)
    const ci = detail.querySelector('input[data-comment-input="2"]') as HTMLInputElement;
    ci.value = 'caret height looks off at 50';
    ci.dispatchEvent(new Event('input', { bubbles: true }));
    click(detail.querySelector('button[data-comment-pin="2"]') as HTMLButtonElement);
    await tick();
    expect(rec.getComment(id, 2)).toBe('caret height looks off at 50');
    expect(target.querySelector('button[data-entry-seq="2"] .cmt')).not.toBeNull(); // marker on the row
    expect(localStorage.getItem(STORAGE_KEY)).toContain('caret height looks off at 50');

    // paint toggle: on → entries additionally carry the paint fields (diff rule applies)
    const cb = target.querySelector('input[data-paint-toggle]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    startRecording(target, 'paint bug');
    await tick();
    const live = rec.currentRecording()!;
    expect(live.paintGeometry).toBe(true);
    const base = live.entries[0];
    expect(base.paint).toBeDefined();
    expect(Object.keys(base.paint!).sort()).toEqual(['anchorKey', 'anchorRect', 'caretRect']);
    expect(base.paint!.anchorKey).toBe('[]'); // caret token@1 on the num → extent element key
    press(editor, '7'); // caret was at token@1 after the arrow → 570
    const e1 = live.entries[1];
    expect(e1.ast).toEqual({ v: 1, root: { type: 'num', value: 570 } });
    await unmount(app as never);
  });
});

describe('test logger — whitelist-as-data and element-level diff on live entries', () => {
  it('a property outside the whitelist never appears in any entry — the sampler offers non-whitelist values on purpose', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    // the fake style reader answers for EVERY prop it is asked — including
    // non-whitelisted ones, which the recorder must never even query
    const offered: Record<string, string> = { color: 'rgb(0, 0, 0)', margin: '7px', 'z-index': '5', display: 'block' };
    rec.sampler = {
      containerRect: () => ({ left: 0, top: 0 }),
      rect: () => ({ x: 0, y: 0, w: 0, h: 0 }),
      styleValue: (_el, prop) => offered[prop] ?? '',
    };
    startRecording(target);
    click(target.querySelector('button[data-case-id="K-16"]') as HTMLButtonElement); // a+b, rebuilds + samples
    offered.color = 'rgb(9, 9, 9)'; // a whitelisted prop changes AFTER the load
    press(editor, 'ArrowLeft'); // caret-only move, no rebuild — styles re-sampled
    const entries = rec.currentRecording()!.entries;
    const last = entries[entries.length - 1];
    // every styles value across every entry is whitelist-only; the offered
    // non-whitelist values (margin 7px, z-index 5) never appear anywhere
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain('7px');
    expect(raw).not.toContain('z-index');
    for (const e of entries) {
      for (const elStyles of Object.values(e.styles ?? {})) {
        if (elStyles === null) continue;
        for (const prop of Object.keys(elStyles)) {
          expect(STYLE_WHITELIST).toContain(prop);
        }
      }
    }
    // the changed whitelisted prop surfaces as a PARTIAL diff (changed prop only)
    expect(last.styles!['math']).toEqual({ color: 'rgb(9, 9, 9)' });
    expect(last.ast).toBeUndefined(); // the arrow changed no tree
    await unmount(app as never);
  });

  it('element-level diff: changed elements only, keyed by stable path keys (injected sampler)', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    const rec = app.getRecorder()!;
    const fake: Record<string, Rect> = { math: { x: 0, y: 0, w: 100, h: 20 } };
    rec.sampler = {
      containerRect: () => ({ left: 0, top: 0 }),
      rect: (_el, key) => fake[key] ?? { x: 0, y: 0, w: 0, h: 0 },
      styleValue: () => '',
    };
    startRecording(target);
    const base = rec.currentRecording()!.entries[0];
    expect(base.rects).toEqual({ math: { x: 0, y: 0, w: 100, h: 20 } }); // baseline full
    fake['[]'] = { x: 0, y: 0, w: 10, h: 20 };
    press(editor, '5');
    const e1 = rec.currentRecording()!.entries[1];
    expect(e1.rects).toEqual({ '[]': { x: 0, y: 0, w: 10, h: 20 } }); // only the NEW element
    fake['[]'] = { x: 0, y: 0, w: 12, h: 20 };
    press(editor, '0');
    const e2 = rec.currentRecording()!.entries[2];
    expect(e2.rects).toEqual({ '[]': { x: 0, y: 0, w: 12, h: 20 } }); // only the CHANGED element; math absent
    await unmount(app as never);
  });

  it('element keys: stable AST path keys plus semantic keys, surviving the per-change rebuild', async () => {
    const { target, app } = mountApp();
    await tick();
    const editor = editorOf(target);
    editor.focus();
    click(target.querySelector('button[data-case-id="K-18"]') as HTMLButtonElement); // x + 12/34 + y
    const keys1 = [...elementKeys(app.getController()!.getRendered()!).values()];
    expect(keys1).toContain('math');
    expect(keys1).toContain('[]');
    expect(keys1).toContain('[0]');
    expect(keys1).toContain('[1]');
    expect(keys1).toContain('[1,"num"]');
    expect(keys1).toContain('[1,"den"]');
    expect(keys1.some((k) => k.startsWith('sep:'))).toBe(true); // the + glyph separators
    // a tree change rebuilds the whole MathML (fresh uids) — the path keys are stable
    press(editor, 'z');
    const keys2 = [...elementKeys(app.getController()!.getRendered()!).values()];
    for (const k of ['math', '[]', '[0]', '[1]', '[1,"num"]', '[1,"den"]']) {
      expect(keys2).toContain(k);
    }
    await unmount(app as never);
  });
});
