// recorder — the demo usability-test logger's capture side: a PASSIVE
// instrument around the one case editor. It observes the input stream
// (capture-phase listeners on the editor container's parent, so the editor's
// own handlers always run first), samples the full machine state after each
// input, and appends one unified-diff entry per input to the open recording.
// It never calls preventDefault, never mutates editor state, never touches the
// engine — instrumentation only.
//
// Capture mechanics (keydown-only since the 2026-11-11 dogfood ruling — the
// engine has no keyup-driven behavior, so keyup events are not captured at all):
//  - a CAPTURE listener on the container's PARENT fires before the container's
//    own handlers (true capture order), records the pending input (keys only
//    while the editor is focused — mirroring the controller's focus gate;
//    clicks always), and
//  - a BUBBLE listener on the same parent fires after every container handler
//    for that event, flushing one entry from the controller's then-current
//    state (synchronous per event, so synthetic key loops still log per key).
//  - a bare modifier keydown (Shift/Control/Alt/Meta) records NOTHING — its
//    state rides on the following steps via each keydown's modifier flags.
//  - programmatic editor actions from demo UI outside the container (case
//    loads, the T9 vocabulary buttons) go through recordAction(), which wraps
//    the action and flushes synchronously — a case load mid-recording is one
//    normal entry (input = case load).
//
// Element identity across the per-change MathML rebuild: the renderer assigns
// fresh uids per rebuild, so entries key elements by their STABLE AST path
// (pathKey) plus semantic keys for the uid-less elements (fences, separators,
// placeholders, fn heads, sub labels, seam markers).
//
// Dev-only demo code — NOT part of the published package.

import { toMathML, type Envelope } from '../src/ast/index.js';
import {
  caretAnchor,
  caretKey,
  classifyKey,
  pathKey,
  seamAnchorSpec,
  type EditorController,
  type RenderedMath,
  type SeamAnchorSpec,
} from '../src/editor/index.js';
import { envelopeOf, isRowNode, nodeAt, rowArgs, type Caret, type Path } from '../src/engine/index.js';

import {
  LOG_VERSION,
  diffSnapshots,
  serializeBugFile,
  serializeClusterFile,
  serializeStorage,
  parseStorage,
  STYLE_WHITELIST,
  type InputEvent,
  type PaintState,
  type Rect,
  type RejectionInfo,
  type Snapshot,
  type StoredRecording,
  type TestEntry,
} from './logger-core.js';

export const STORAGE_KEY = 'integral-testlog:v1';

/** The caret overlay div's painted width (mirrors CARET_CSS in the controller). */
const CARET_OVERLAY_WIDTH = 2;

/** Injectable geometry/style sampling — jsdom has no layout, so tests inject a
 *  key-based fake; the default samples the real DOM. */
export interface GeometrySampler {
  containerRect(): { left: number; top: number };
  /** Container-relative rect of one rendered element (key = the entry's element key). */
  rect(el: Element, key: string): Rect;
  styleValue(el: Element, prop: string): string;
}

export function domGeometrySampler(container: HTMLElement): GeometrySampler {
  return {
    containerRect: () => {
      const r = container.getBoundingClientRect();
      return { left: r.left, top: r.top };
    },
    rect: (el, _key) => {
      const r = el.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    },
    styleValue: (el, prop) => container.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue(prop) ?? '',
  };
}

/**
 * Element → stable entry key for one rendered tree. Path keys come first and
 * win (every uid element keeps its AST path across rebuilds); the uid-less
 * special elements get semantic keys; seam markers key by document order.
 */
export function elementKeys(rendered: RenderedMath): Map<Element, string> {
  const keys = new Map<Element, string>();
  keys.set(rendered.math, 'math');
  for (const [key, el] of rendered.elementByPath) {
    if (!keys.has(el)) keys.set(el, key);
  }
  const add = (el: Element | undefined | null, key: string): void => {
    if (el != null && !keys.has(el)) keys.set(el, key);
  };
  for (const [el, info] of rendered.fenceGlyphs) add(el, `fence:${pathKey(info.path)}:${info.side}`);
  for (const [el, info] of rendered.separators) add(el, `sep:${pathKey(info.path)}/${info.index}`);
  for (const [el, caret] of rendered.placeholders) add(el, `ph:${caretKey(caret)}`);
  for (const [el, path] of rendered.fnHeads) add(el, `fnhead:${pathKey(path)}`);
  for (const [key, labels] of rendered.subLabels) {
    add(labels.base, `sublabel:${key}:base`);
    add(labels.script, `sublabel:${key}:script`);
  }
  rendered.math.querySelectorAll('.integral-seam').forEach((el, i) => add(el as Element, `seam#${i}`));
  return keys;
}

/**
 * The element the caret overlay anchors at — a demo-local mirror of
 * caret-overlay.ts's anchor selection (the anchor element itself is not
 * exported; the exported caretAnchor yields coordinates only). Used ONLY by
 * the paint-geometry toggle. Returns the element plus its entry key.
 */
function anchorElementOf(
  env: Envelope,
  caret: Caret,
  rendered: RenderedMath,
  keyOf: (el: Element) => string | undefined,
): { el: Element; key: string } | null {
  const keyFor = (el: Element): string => keyOf(el) ?? `el#${el.localName}`;
  const sepEl = (spec: Extract<SeamAnchorSpec, { readonly kind: 'separator' }>): Element | null =>
    rendered.separatorBySeam.get(`${pathKey(spec.rowPath as Path)}/${spec.index}`) ?? null;
  switch (caret.kind) {
    case 'empty':
      return { el: rendered.math, key: 'math' };
    case 'node': {
      const ext = rendered.extents.get(pathKey(caret.path));
      if (ext === undefined) return null;
      if (caret.side === 'left') {
        const spec = seamAnchorSpec(env, caret);
        if (spec !== null) {
          const el = spec.kind === 'separator' ? sepEl(spec) : (rendered.elementByPath.get(pathKey(spec.path)) ?? null);
          if (el !== null) return { el, key: keyFor(el) };
        }
      }
      const el = caret.side === 'right' ? ext.last : ext.first;
      return { el, key: keyFor(el) };
    }
    case 'slot': {
      const ph = rendered.placeholderByCaret.get(caretKey(caret));
      return ph === undefined ? null : { el: ph, key: keyFor(ph) };
    }
    case 'row': {
      const row = nodeAt(env, caret.path);
      if (row === null || !isRowNode(row)) return null;
      const args = rowArgs(row);
      const rowCaret = { kind: 'row', path: caret.path, index: caret.index } as const;
      if (caret.index < args.length) {
        const ph = rendered.placeholderByCaret.get(caretKey(rowCaret));
        if (ph !== undefined) return { el: ph, key: keyFor(ph) };
        const bare = rendered.bareAnchors.get(caretKey(rowCaret));
        if (bare !== undefined && bare !== null) {
          const el = bare.glyphEl ?? bare.rowEl;
          return { el, key: keyFor(el) };
        }
        const spec = seamAnchorSpec(env, caret);
        if (spec !== null && spec.kind === 'separator') {
          const el = sepEl(spec);
          if (el !== null) return { el, key: keyFor(el) };
        }
        const ext = rendered.extents.get(pathKey([...caret.path, caret.index]));
        return ext === undefined ? null : { el: ext.first, key: keyFor(ext.first) };
      }
      if (args.length === 0) {
        const owner = rendered.elementByPath.get(pathKey(caret.path));
        return owner === undefined ? null : { el: owner, key: keyFor(owner) };
      }
      const ext = rendered.extents.get(pathKey([...caret.path, args.length - 1]));
      return ext === undefined ? null : { el: ext.last, key: keyFor(ext.last) };
    }
    case 'token': {
      const node = nodeAt(env, caret.path);
      if (node === null) return null;
      if (node.type === 'sub') {
        const labels = rendered.subLabels.get(pathKey(caret.path));
        const el = caret.label === 'sub' ? labels?.script : labels?.base;
        return el === undefined ? null : { el, key: keyFor(el) };
      }
      if (node.type === 'unit') {
        const el = rendered.elementByPath.get(pathKey(caret.path));
        return el === undefined ? null : { el, key: keyFor(el) };
      }
      const ext = rendered.extents.get(pathKey(caret.path));
      return ext === undefined ? null : { el: ext.first, key: keyFor(ext.first) };
    }
  }
}

export interface RecordingSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly entryCount: number;
  readonly commentCount: number;
}

export interface RecorderOptions {
  readonly container: HTMLElement;
  /** Live controller lookup — survives the demo's controller re-creation (case load, blur-resume). */
  readonly getController: () => EditorController | null;
  readonly onChange?: () => void;
  /** Injectable for tests (jsdom localStorage by default). */
  readonly storage?: Storage | null;
  /** Injectable geometry sampler (real DOM by default). */
  sampler?: GeometrySampler;
  readonly now?: () => number;
}

interface PendingInput {
  readonly input: InputEvent;
  readonly t: number;
  /** classifyKey kind at capture time (the rejection in the header belongs to typing-class keys only). */
  readonly actionKind: string;
}

export class Recorder {
  private readonly container: HTMLElement;
  private readonly getController: () => EditorController | null;
  private readonly onChange?: () => void;
  private readonly storage: Storage | null;
  private readonly now: () => number;
  private readonly parent: HTMLElement;
  sampler: GeometrySampler;
  /** Paint-geometry toggle (off by default). */
  paintOn = false;
  private recordings: StoredRecording[] = [];
  private recording: StoredRecording | null = null;
  private lastSnap: Snapshot | null = null;
  private pending: PendingInput | null = null;
  private idCounter = 0;

  constructor(options: RecorderOptions) {
    this.container = options.container;
    this.getController = options.getController;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => Date.now());
    this.sampler = options.sampler ?? domGeometrySampler(options.container);
    const view = options.container.ownerDocument.defaultView;
    this.storage = options.storage !== undefined ? options.storage : (view?.localStorage ?? null);
    const parent = options.container.parentElement;
    if (parent === null) throw new Error('Recorder: the editor container needs a parent element');
    this.parent = parent;
    this.load();
    parent.addEventListener('keydown', this.onCapture, true);
    parent.addEventListener('compositionend', this.onCapture, true);
    parent.addEventListener('click', this.onCapture, true);
    parent.addEventListener('keydown', this.onBubble);
    parent.addEventListener('compositionend', this.onBubble);
    parent.addEventListener('click', this.onBubble);
  }

  // ——— state machine ———

  isRecording(): boolean {
    return this.recording !== null;
  }

  /** The open recording (live view — the panel lists its entries). */
  currentRecording(): StoredRecording | null {
    return this.recording;
  }

  /** Start recording: the first entry is the FULL baseline (seq 0). The title
   *  passed here is only the live draft — the record's final name is read from
   *  the name input at STOP time (stopRecording), verbatim. */
  startRecording(title: string): void {
    if (this.recording !== null) return;
    const ctl = this.getController();
    if (ctl === null) return;
    const nowIso = new Date(this.now()).toISOString();
    const rec: StoredRecording = {
      id: `rec-${this.now().toString(36)}-${(this.idCounter++).toString(36)}`,
      title,
      createdAt: nowIso,
      updatedAt: nowIso,
      paintGeometry: this.paintOn,
      entries: [],
      comments: {},
    };
    this.recording = rec;
    this.lastSnap = this.sample(ctl);
    const baseline: TestEntry = { seq: 0, t: this.now(), input: { kind: 'record-start' }, ...diffSnapshots(null, this.lastSnap) };
    rec.entries.push(baseline);
    this.persist();
    this.onChange?.();
  }

  /** Stop recording. The record takes its name from `name` — the name input's
   *  content at stop time, verbatim (empty input → empty title; the createdAt
   *  timestamp stays) — and joins the saved list. */
  stopRecording(name: string): StoredRecording | null {
    const rec = this.recording;
    if (rec === null) return null;
    const stopped: StoredRecording = { ...rec, title: name, updatedAt: new Date(this.now()).toISOString() };
    // the stopped recording joins the saved list (it was only the live one until now)
    this.recordings = [...this.recordings.filter((r) => r.id !== rec.id), stopped];
    this.recording = null;
    this.pending = null;
    this.lastSnap = null;
    this.persist();
    this.onChange?.();
    return stopped;
  }

  /** Rename a recording (the demo's one name input is the rename surface). */
  renameRecording(id: string, title: string): void {
    const rec = this.allRecordings().find((r) => r.id === id);
    if (rec === undefined) return;
    const updated: StoredRecording = { ...rec, title, updatedAt: new Date(this.now()).toISOString() };
    this.recordings = this.recordings.map((r) => (r.id === id ? updated : r));
    if (this.recording?.id === id) this.recording = updated;
    this.persist();
    this.onChange?.();
  }

  setPaint(on: boolean): void {
    this.paintOn = on;
    if (this.recording !== null) {
      this.recording = { ...this.recording, paintGeometry: on, updatedAt: new Date(this.now()).toISOString() };
    }
  }

  // ——— capture ———

  /** Capture-phase: record the pending input (before the editor's handlers). */
  private readonly onCapture = (ev: Event): void => {
    if (this.recording === null || this.pending !== null) return;
    const target = ev.target;
    if (!(target instanceof Node) || !this.container.contains(target)) return;
    const input = this.inputFromEvent(ev);
    if (input === null) return;
    const actionKind = ev instanceof KeyboardEvent ? classifyKey(ev).kind : 'other';
    this.pending = { input, t: this.now(), actionKind };
  };

  /** Bubble-phase: after every container handler for the event — flush one entry. */
  private readonly onBubble = (ev: Event): void => {
    if (this.pending === null) return;
    const target = ev.target;
    if (!(target instanceof Node) || !this.container.contains(target)) return;
    this.flush();
  };

  private inputFromEvent(ev: Event): InputEvent | null {
    const doc = this.container.ownerDocument;
    if (ev.type === 'click') {
      const me = ev as MouseEvent;
      const t = me.target as Element | null;
      const el = t !== null && typeof t.closest === 'function' ? t.closest('[id]') : null;
      let target = t === null ? 'background' : (el?.id ?? t.localName ?? 'background');
      if (el !== null) {
        const rendered = this.getController()?.getRendered();
        const path = rendered?.pathByUid.get(el.id);
        if (path !== undefined) target = pathKey(path);
      }
      return { kind: 'click', x: me.clientX, y: me.clientY, target };
    }
    if (ev.type === 'keydown' || ev.type === 'compositionend') {
      // mirror the controller's focus gate: keys while the editor is not
      // focused are not actions on the editor — no entry
      if (doc.activeElement !== this.container) return null;
      const ke = ev as KeyboardEvent;
      // keydown-only capture: a bare modifier keydown is not an action — no
      // step of its own; the modifier state rides on the next keydown's mods
      if (ev.type === 'keydown' && (ke.key === 'Shift' || ke.key === 'Control' || ke.key === 'Alt' || ke.key === 'Meta')) return null;
      const mods = `${ke.altKey ? 'A' : ''}${ke.ctrlKey ? 'C' : ''}${ke.metaKey ? 'M' : ''}${ke.shiftKey ? 'S' : ''}`;
      return { kind: 'key', type: ev.type, key: ke.key, code: ke.code ?? '', mods };
    }
    return null;
  }

  /** Wrap a programmatic editor action (case load, vocabulary buttons) so it
   *  logs as one entry when recording. */
  recordAction(fn: () => void, input: InputEvent): void {
    if (this.recording === null) {
      fn();
      return;
    }
    this.pending = { input, t: this.now(), actionKind: 'other' };
    try {
      fn();
    } finally {
      this.flush();
    }
  }

  /** One entry from the controller's current state, diffed against the last. */
  private flush(): void {
    const pending = this.pending;
    const rec = this.recording;
    if (pending === null || rec === null) return;
    this.pending = null;
    const ctl = this.getController();
    if (ctl === null) return;
    const snap = this.sample(ctl);
    const diffs = diffSnapshots(this.lastSnap, snap);
    const rejection = this.readRejection(pending, ctl);
    const entry: TestEntry = {
      seq: rec.entries.length,
      t: pending.t,
      input: pending.input,
      ...(rejection === null ? {} : { rejection }),
      ...diffs,
    };
    rec.entries.push(entry);
    this.lastSnap = snap;
    this.persist();
    this.onChange?.();
  }

  /** getLastRejection-class info, but only when THIS input was a typing-class
   *  key (the controller keeps the last rejection across non-typing keys). */
  private readRejection(pending: PendingInput, ctl: EditorController): RejectionInfo | null {
    if (pending.input.kind !== 'key' || pending.input.type !== 'keydown' || pending.actionKind !== 'type') return null;
    const r = ctl.getLastRejection();
    if (r === null) return null;
    return { kind: r.kind, name: r.name, message: r.message, ...(r.token !== undefined ? { token: r.token } : {}) };
  }

  // ——— sampling ———

  private sample(ctl: EditorController): Snapshot {
    const state = ctl.getState();
    const env = envelopeOf(state) as Envelope;
    const rendered = ctl.getRendered();
    const caret = JSON.parse(JSON.stringify(state.caret)) as unknown;
    const mathml = toMathML(state.root);
    let caretRect: Rect | null = null;
    const rects: Record<string, Rect> = {};
    const styles: Record<string, Record<string, string>> = {};
    let paint: PaintState | null = null;
    if (rendered !== null) {
      const anchor = caretAnchor(env, state.caret, rendered);
      if (anchor !== null) {
        const cr = this.sampler.containerRect();
        caretRect = { x: anchor.x - cr.left, y: anchor.y - cr.top, w: CARET_OVERLAY_WIDTH, h: anchor.height };
      }
      const keys = elementKeys(rendered);
      for (const [el, key] of keys) {
        rects[key] = this.sampler.rect(el, key);
        const s: Record<string, string> = {};
        for (const prop of STYLE_WHITELIST) s[prop] = this.sampler.styleValue(el, prop);
        styles[key] = s;
      }
      if (this.paintOn) {
        const caretDiv = this.container.querySelector('.integral-caret');
        const anchorEl = anchorElementOf(env, state.caret, rendered, (el) => keys.get(el));
        paint = {
          caretRect: caretDiv !== null ? this.sampler.rect(caretDiv, 'caret-overlay') : null,
          anchorRect: anchorEl !== null ? this.sampler.rect(anchorEl.el, anchorEl.key) : null,
          anchorKey: anchorEl?.key ?? null,
        };
      }
    }
    return { caret, caretRect, ast: env, mathml, rects, styles, paint };
  }

  // ——— persistence (localStorage) + management ———

  private allRecordings(): StoredRecording[] {
    return this.recording !== null ? [...this.recordings, this.recording] : this.recordings;
  }

  private persist(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(STORAGE_KEY, serializeStorage({ version: LOG_VERSION, recordings: this.allRecordings() }));
    } catch {
      // private mode / quota — the recording still lives in memory
    }
  }

  private load(): void {
    if (this.storage === null) return;
    try {
      const text = this.storage.getItem(STORAGE_KEY);
      if (text !== null) this.recordings = parseStorage(text).recordings;
    } catch {
      this.recordings = [];
    }
  }

  listRecordings(): RecordingSummary[] {
    return this.allRecordings()
      .map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        entryCount: r.entries.length,
        commentCount: Object.keys(r.comments).length,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getRecording(id: string): StoredRecording | null {
    return this.allRecordings().find((r) => r.id === id) ?? null;
  }

  deleteRecording(id: string): void {
    this.recordings = this.recordings.filter((r) => r.id !== id);
    if (this.recording?.id === id) this.recording = null;
    this.persist();
    this.onChange?.();
  }

  setComment(id: string, seq: number, text: string): void {
    const rec = this.allRecordings().find((r) => r.id === id);
    if (rec === undefined) return;
    const comments = { ...rec.comments };
    if (text === '') delete comments[String(seq)];
    else comments[String(seq)] = text;
    const updated: StoredRecording = { ...rec, comments, updatedAt: new Date(this.now()).toISOString() };
    this.recordings = this.recordings.map((r) => (r.id === id ? updated : r));
    if (this.recording?.id === id) this.recording = updated;
    this.persist();
    this.onChange?.();
  }

  getComment(id: string, seq: number): string | undefined {
    return this.getRecording(id)?.comments[String(seq)];
  }

  // ——— export (text-only JSON bug files; downloads land wherever the browser saves) ———

  exportOne(id: string): string | null {
    const rec = this.getRecording(id);
    return rec === null ? null : serializeBugFile(rec, new Date(this.now()).toISOString());
  }

  exportAll(): string {
    return serializeClusterFile(this.allRecordings(), new Date(this.now()).toISOString());
  }

  destroy(): void {
    this.parent.removeEventListener('keydown', this.onCapture, true);
    this.parent.removeEventListener('compositionend', this.onCapture, true);
    this.parent.removeEventListener('click', this.onCapture, true);
    this.parent.removeEventListener('keydown', this.onBubble);
    this.parent.removeEventListener('compositionend', this.onBubble);
    this.parent.removeEventListener('click', this.onBubble);
  }
}

/** Browser download of a text file (export-one / export-all). */
export function downloadText(filename: string, text: string): void {
  const a = document.createElement('a');
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    // jsdom / no createObjectURL: data-URL fallback
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
