// logger-core — the PURE core of the demo's usability-test logger: the unified
// diff-log schema (the exported bug-file format), the diff computation, the
// last-known-value resolution, the derived mechanical-no-op flag, and the
// storage/export serialization.
//
// Dev-only demo code — NOT part of the published package. No DOM and no editor
// imports here: everything is data in / data out, so the whole schema and diff
// logic is pinned in the plain node test environment (no jsdom geometry needed —
// rects arrive as injected values).
//
// THE ONE RULE OF THE SCHEMA: a diff field appears in an entry only when it
// changed since the previous entry; absent = unchanged. The baseline entry
// (seq 0, input `record-start`) carries every field in full — it is the state
// all later entries diff against.

/** Export/storage format marker (schema-stable: parse rejects anything else). */
export const LOG_FORMAT = 'integral-testlog';
/** Schema version of the bug file + storage blob. */
export const LOG_VERSION = 1;

/** A container-relative rect (baked at capture time from real layout). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The input event that produced an entry (the header's event field). */
export type InputEvent =
  | { readonly kind: 'record-start' }
  | { readonly kind: 'key'; readonly type: string; readonly key: string; readonly code: string; readonly mods: string }
  | { readonly kind: 'click'; readonly x?: number; readonly y?: number; readonly target: string }
  | { readonly kind: 'case-load'; readonly caseId: string };

/** The engine rejection class of an entry (getLastRejection-class info) — part
 *  of the header, present only when the engine rejected the input. */
export interface RejectionInfo {
  readonly kind: string;
  readonly name: string;
  readonly message: string;
  readonly token?: unknown;
}

/** Paint-geometry fields (toggle-gated): the caret overlay rect and the anchor
 *  element's rect, both container-relative as actually painted. */
export interface PaintState {
  readonly caretRect: Rect | null;
  readonly anchorRect: Rect | null;
  readonly anchorKey: string | null;
}

/** One recorded step. Header fields (seq/t/input, + rejection when the engine
 *  rejected the input) are always present; every other field is a DIFF —
 *  present only when changed since the previous entry. */
export interface TestEntry {
  readonly seq: number;
  readonly t: number;
  readonly input: InputEvent;
  readonly rejection?: RejectionInfo;
  readonly caret?: unknown;
  readonly caretRect?: Rect | null;
  readonly ast?: unknown;
  readonly mathml?: string;
  readonly rects?: Record<string, Rect | null>;
  readonly styles?: Record<string, Record<string, string> | null>;
  readonly paint?: Partial<PaintState>;
}

/** The diff fields of an entry (everything except the header) — mutable so
 *  diffSnapshots can build them incrementally. */
export interface EntryDiffs {
  caret?: unknown;
  caretRect?: Rect | null;
  ast?: unknown;
  mathml?: string;
  rects?: Record<string, Rect | null>;
  styles?: Record<string, Record<string, string> | null>;
  paint?: Partial<PaintState>;
}

/** A full sampled machine state (what the recorder snapshots per input; the
 *  entry stores only the diff against the previous snapshot). */
export interface Snapshot {
  readonly caret: unknown;
  readonly caretRect: Rect | null;
  readonly ast: unknown;
  readonly mathml: string;
  readonly rects: Record<string, Rect>;
  readonly styles: Record<string, Record<string, string>>;
  readonly paint: PaintState | null;
}

/** Whitelisted computed-style properties — AS DATA: adding a property is a
 *  one-line change here, and a property outside this list can never appear in
 *  an entry (the sampler only ever queries these). */
export const STYLE_WHITELIST: readonly string[] = [
  'display',
  'visibility',
  'opacity',
  'pointer-events',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'vertical-align',
  'height',
  'width',
  'color',
  'background-color',
];

/** Keep only the whitelisted properties of a computed-style-like record. */
export function pickWhitelisted(computed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of STYLE_WHITELIST) {
    if (prop in computed) out[prop] = computed[prop];
  }
  return out;
}

// ——— diffing ———

const rectEq = (a: Rect | null | undefined, b: Rect | null | undefined): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
};

const copyStyles = (styles: Record<string, Record<string, string>>): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(styles)) out[k] = { ...v };
  return out;
};

/**
 * Diff two snapshots into entry diffs. `prev === null` is the baseline: every
 * field is returned in full. Otherwise a field appears only when changed.
 * Removed elements (rects/styles keys absent from `next`) are recorded as
 * `null` — their last-known value still resolves via resolveAt until then.
 */
export function diffSnapshots(prev: Snapshot | null, next: Snapshot): EntryDiffs {
  if (prev === null) {
    const full: EntryDiffs = {
      caret: next.caret,
      caretRect: next.caretRect,
      ast: next.ast,
      mathml: next.mathml,
      rects: { ...next.rects },
      styles: copyStyles(next.styles),
    };
    if (next.paint !== null) full.paint = { ...next.paint };
    return full;
  }
  const d: EntryDiffs = {};
  if (JSON.stringify(prev.caret) !== JSON.stringify(next.caret)) d.caret = next.caret;
  if (!rectEq(prev.caretRect, next.caretRect)) d.caretRect = next.caretRect;
  if (JSON.stringify(prev.ast) !== JSON.stringify(next.ast)) d.ast = next.ast;
  if (prev.mathml !== next.mathml) d.mathml = next.mathml;
  const rectDiff: Record<string, Rect | null> = {};
  for (const k of Object.keys(next.rects)) {
    const a = prev.rects[k];
    const b = next.rects[k];
    if (a === undefined || !rectEq(a, b)) rectDiff[k] = b;
  }
  for (const k of Object.keys(prev.rects)) {
    if (!(k in next.rects)) rectDiff[k] = null;
  }
  if (Object.keys(rectDiff).length > 0) d.rects = rectDiff;
  const styleDiff: Record<string, Record<string, string> | null> = {};
  for (const k of Object.keys(next.styles)) {
    const a = prev.styles[k];
    const b = next.styles[k];
    if (a === undefined) {
      styleDiff[k] = { ...b };
      continue;
    }
    const props: Record<string, string> = {};
    for (const p of Object.keys(b)) {
      if (a[p] !== b[p]) props[p] = b[p];
    }
    if (Object.keys(props).length > 0) styleDiff[k] = props;
  }
  for (const k of Object.keys(prev.styles)) {
    if (!(k in next.styles)) styleDiff[k] = null;
  }
  if (Object.keys(styleDiff).length > 0) d.styles = styleDiff;
  if (prev.paint !== null || next.paint !== null) {
    const pDiff: { caretRect?: Rect | null; anchorRect?: Rect | null; anchorKey?: string | null } = {};
    const a = prev.paint;
    const b = next.paint;
    if (!rectEq(a?.caretRect ?? null, b?.caretRect ?? null)) pDiff.caretRect = b?.caretRect ?? null;
    if (!rectEq(a?.anchorRect ?? null, b?.anchorRect ?? null)) pDiff.anchorRect = b?.anchorRect ?? null;
    if ((a?.anchorKey ?? null) !== (b?.anchorKey ?? null)) pDiff.anchorKey = b?.anchorKey ?? null;
    if (Object.keys(pDiff).length > 0) d.paint = pDiff;
  }
  return d;
}

/**
 * The mechanical no-op flag — DERIVED, never stored: an entry whose only diff
 * is caret state (no tree change, no MathML change, no caret-rect change, no
 * element rect/style change, no paint change) is a mechanical twin/seam-family
 * no-op candidate. A header-only entry (rejected / silent no-op input) is NOT
 * flagged — it changed nothing at all, not even the caret.
 */
export function deriveMechanicalNoop(entry: {
  readonly caret?: unknown;
  readonly caretRect?: unknown;
  readonly ast?: unknown;
  readonly mathml?: unknown;
  readonly rects?: unknown;
  readonly styles?: unknown;
  readonly paint?: unknown;
}): boolean {
  return (
    entry.caret !== undefined &&
    entry.caretRect === undefined &&
    entry.ast === undefined &&
    entry.mathml === undefined &&
    entry.rects === undefined &&
    entry.styles === undefined &&
    entry.paint === undefined
  );
}

// ——— last-known-value resolution ("state in effect at entry N") ———

/** The resolved machine state at entry `n`: each field's most recent value at
 *  or before `n` (rects/styles/paint merge cumulatively; `null` removes). */
export interface ResolvedState {
  readonly caret: unknown;
  readonly caretRect: Rect | null;
  readonly ast: unknown;
  readonly mathml: string;
  readonly rects: Record<string, Rect>;
  readonly styles: Record<string, Record<string, string>>;
  readonly paint: PaintState | null;
}

export function resolveAt(entries: readonly TestEntry[], n: number): ResolvedState {
  if (entries.length === 0) throw new Error('resolveAt: empty log');
  const base = entries[0];
  if (base.ast === undefined || base.rects === undefined || base.styles === undefined) {
    throw new Error('resolveAt: entry 0 is not a full baseline');
  }
  let caret: unknown = base.caret;
  let caretRect: Rect | null = base.caretRect ?? null;
  let ast: unknown = base.ast;
  let mathml = base.mathml ?? '';
  // the baseline is full by contract (checked above) — the diff types allow nulls, the baseline doesn't
  const rects: Record<string, Rect> = { ...(base.rects as Record<string, Rect>) };
  const styles = copyStyles(base.styles as Record<string, Record<string, string>>);
  // the baseline paint is full by contract; the Partial type still needs normalizing
  let paint: PaintState | null = base.paint
    ? { caretRect: base.paint.caretRect ?? null, anchorRect: base.paint.anchorRect ?? null, anchorKey: base.paint.anchorKey ?? null }
    : null;
  const upto = Math.min(n, entries.length - 1);
  for (let i = 1; i <= upto; i += 1) {
    const e = entries[i];
    if (e.caret !== undefined) caret = e.caret;
    if (e.caretRect !== undefined) caretRect = e.caretRect;
    if (e.ast !== undefined) ast = e.ast;
    if (e.mathml !== undefined) mathml = e.mathml;
    if (e.rects !== undefined) {
      for (const [k, v] of Object.entries(e.rects)) {
        if (v === null) delete rects[k];
        else rects[k] = v;
      }
    }
    if (e.styles !== undefined) {
      for (const [k, v] of Object.entries(e.styles)) {
        if (v === null) delete styles[k];
        else styles[k] = { ...(styles[k] ?? {}), ...v };
      }
    }
    if (e.paint !== undefined) {
      paint = {
        caretRect: e.paint.caretRect !== undefined ? e.paint.caretRect : (paint?.caretRect ?? null),
        anchorRect: e.paint.anchorRect !== undefined ? e.paint.anchorRect : (paint?.anchorRect ?? null),
        anchorKey: e.paint.anchorKey !== undefined ? e.paint.anchorKey : (paint?.anchorKey ?? null),
      };
    }
  }
  return { caret, caretRect, ast, mathml, rects, styles, paint };
}

// ——— storage + export (the bug file) ———

/** One persisted recording = one bug. Entries are stored WITHOUT any derived
 *  field (the no-op flag is derived at panel/export time, never stored);
 *  comments live in a seq-keyed map so they never touch the diff schema. */
export interface StoredRecording {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paintGeometry: boolean;
  readonly entries: TestEntry[];
  readonly comments: Record<string, string>;
}

export interface StorageBlob {
  readonly version: number;
  readonly recordings: StoredRecording[];
}

export function serializeStorage(blob: StorageBlob): string {
  return JSON.stringify(blob);
}

export function parseStorage(text: string): StorageBlob {
  const parsed = JSON.parse(text) as Partial<StorageBlob>;
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== LOG_VERSION || !Array.isArray(parsed.recordings)) {
    throw new Error('parseStorage: not an integral testlog storage blob');
  }
  return parsed as StorageBlob;
}

/** One entry as it appears in an exported bug file: the stored entry plus the
 *  DERIVED mechanical-noop flag and the pinned comment (both derived/merged at
 *  export time — never stored on the entry). */
export function exportEntry(entry: TestEntry, comment?: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry, mechanicalNoop: deriveMechanicalNoop(entry) };
  if (comment !== undefined && comment !== '') out.comment = comment;
  return out;
}

/** The bug file for one recording (export-one). */
export function bugFile(rec: StoredRecording, exportedAt: string): Record<string, unknown> {
  return {
    format: LOG_FORMAT,
    version: LOG_VERSION,
    kind: 'bug',
    exportedAt,
    id: rec.id,
    title: rec.title,
    recordedAt: rec.createdAt,
    paintGeometry: rec.paintGeometry,
    entries: rec.entries.map((e) => exportEntry(e, rec.comments[String(e.seq)])),
  };
}

/** The cluster file (export-all): every recording as a bug file in one JSON. */
export function clusterFile(recs: readonly StoredRecording[], exportedAt: string): Record<string, unknown> {
  return {
    format: LOG_FORMAT,
    version: LOG_VERSION,
    kind: 'cluster',
    exportedAt,
    recordings: recs.map((r) => bugFile(r, exportedAt)),
  };
}

export function serializeBugFile(rec: StoredRecording, exportedAt: string): string {
  return JSON.stringify(bugFile(rec, exportedAt), null, 2);
}

export function serializeClusterFile(recs: readonly StoredRecording[], exportedAt: string): string {
  return JSON.stringify(clusterFile(recs, exportedAt), null, 2);
}

/** Schema-stable parse of an exported file: accepts only this format+version. */
export function parseLogFile(text: string): { kind?: unknown; entries?: unknown; recordings?: unknown } & Record<string, unknown> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== 'object' || parsed.format !== LOG_FORMAT || parsed.version !== LOG_VERSION) {
    throw new Error(`parseLogFile: not a ${LOG_FORMAT} v${LOG_VERSION} file`);
  }
  return parsed;
}

/** One-line panel label for an entry's input event. */
export function inputSummary(input: InputEvent): string {
  switch (input.kind) {
    case 'record-start':
      return 'record start';
    case 'key':
      return `${input.type} ${JSON.stringify(input.key)}${input.mods !== '' ? ` [${input.mods}]` : ''}`;
    case 'click':
      return `click ${input.target}`;
    case 'case-load':
      return `case load ${input.caseId}`;
  }
}
