// The pure core of the demo usability-test logger (demo/logger-core.ts) —
// node environment, no jsdom: the schema, the unified diff rule, the derived
// no-op flag (with INJECTED rect values), the last-known-value resolution, and
// the storage/export serialization are all pinned here as pure data.

import { describe, expect, it } from 'vitest';

import {
  LOG_FORMAT,
  LOG_VERSION,
  STYLE_WHITELIST,
  bugFile,
  clusterFile,
  deriveMechanicalNoop,
  diffSnapshots,
  exportEntry,
  inputSummary,
  parseLogFile,
  parseStorage,
  pickWhitelisted,
  resolveAt,
  serializeBugFile,
  serializeClusterFile,
  serializeStorage,
  type EntryDiffs,
  type Snapshot,
  type StoredRecording,
  type TestEntry,
} from '../demo/logger-core.js';

const R = (x: number, y = 0, w = 10, h = 20) => ({ x, y, w, h });

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  caret: { kind: 'empty' },
  caretRect: R(0, 0, 2, 20),
  ast: { v: 1, root: null },
  mathml: '',
  rects: { math: R(0, 0, 100, 20) },
  styles: { math: { display: 'block', color: 'rgb(0, 0, 0)' } },
  paint: null,
  ...over,
});

const entry = (seq: number, over: Partial<TestEntry> = {}): TestEntry => ({
  seq,
  t: 1000 + seq,
  input: { kind: 'record-start' },
  ...over,
});

describe('logger-core — style whitelist as data', () => {
  it('pins the exact whitelist (adding a property is a one-line change)', () => {
    expect([...STYLE_WHITELIST]).toEqual([
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
    ]);
  });

  it('pickWhitelisted keeps whitelisted props only — a property outside the list never survives', () => {
    const out = pickWhitelisted({
      display: 'block',
      color: 'red',
      margin: '9px',
      'z-index': '5',
      transform: 'scale(2)',
      position: 'absolute',
    });
    expect(out).toEqual({ display: 'block', color: 'red' });
    expect('margin' in out).toBe(false);
    expect('position' in out).toBe(false);
  });
});

describe('logger-core — unified diff rule', () => {
  it('baseline (prev null) carries every field in full, paint included when sampled', () => {
    const s = snap({ paint: { caretRect: R(1, 2, 2, 20), anchorRect: R(0, 0, 10, 20), anchorKey: 'math' } });
    const d = diffSnapshots(null, s);
    expect(d.caret).toEqual(s.caret);
    expect(d.caretRect).toEqual(s.caretRect);
    expect(d.ast).toEqual(s.ast);
    expect(d.mathml).toEqual(s.mathml);
    expect(d.rects).toEqual(s.rects);
    expect(d.styles).toEqual(s.styles);
    expect(d.paint).toEqual(s.paint);
  });

  it('baseline without paint carries no paint field', () => {
    expect(diffSnapshots(null, snap()).paint).toBeUndefined();
  });

  it('an unchanged next snapshot diffs to nothing', () => {
    const a = snap();
    expect(diffSnapshots(a, snap())).toEqual({});
  });

  it('changed field → present; unchanged → absent (caret, caretRect, ast, mathml)', () => {
    const a = snap();
    const b = snap({ caret: { kind: 'token', path: [0], index: 2 } });
    expect(diffSnapshots(a, b)).toEqual({ caret: b.caret });
    const c = snap({ caretRect: R(14, 0, 2, 20) });
    expect(diffSnapshots(a, c)).toEqual({ caretRect: c.caretRect });
    const d = snap({ ast: { v: 1, root: { type: 'num', value: 5 } } });
    expect(diffSnapshots(a, d)).toEqual({ ast: d.ast });
    const e = snap({ mathml: '<math><mn>5</mn></math>' });
    expect(diffSnapshots(a, e)).toEqual({ mathml: e.mathml });
  });

  it('caretRect null transitions diff both directions', () => {
    const a = snap({ caretRect: null });
    expect(diffSnapshots(a, snap())).toEqual({ caretRect: R(0, 0, 2, 20) });
    expect(diffSnapshots(snap(), snap({ caretRect: null }))).toEqual({ caretRect: null });
  });

  it('element rects: changed elements only; removed elements record null; stable keys carry over', () => {
    const a = snap({ rects: { math: R(0, 0, 100, 20), '[]': R(5, 0, 10, 20), '[0]': R(20, 0, 10, 20) } });
    const b = snap({ rects: { math: R(0, 0, 100, 20), '[]': R(6, 0, 10, 20) } });
    // '[0]' removed → null; '[]' moved → new rect; math unchanged → absent
    expect(diffSnapshots(a, b).rects).toEqual({ '[]': R(6, 0, 10, 20), '[0]': null });
  });

  it('styles: changed elements only, changed props only; removed element → null', () => {
    const a = snap({
      styles: {
        math: { display: 'block', color: 'rgb(0, 0, 0)' },
        '[]': { color: 'rgb(1, 1, 1)', display: 'inline' },
      },
    });
    const b = snap({
      styles: {
        math: { display: 'block', color: 'rgb(9, 9, 9)' }, // only color changed
        '[]': { color: 'rgb(1, 1, 1)', display: 'inline' }, // unchanged → absent
      },
    });
    expect(diffSnapshots(a, b).styles).toEqual({ math: { color: 'rgb(9, 9, 9)' } });
    const c = snap({ styles: { math: { display: 'block', color: 'rgb(0, 0, 0)' } } });
    expect(diffSnapshots(a, c).styles).toEqual({ '[]': null });
  });

  it('paint diff is partial and reacts to each paint field', () => {
    const a = snap({ paint: { caretRect: R(1, 0, 2, 20), anchorRect: R(0, 0, 10, 20), anchorKey: 'math' } });
    const b = snap({ paint: { caretRect: R(2, 0, 2, 20), anchorRect: R(0, 0, 10, 20), anchorKey: 'math' } });
    expect(diffSnapshots(a, b).paint).toEqual({ caretRect: R(2, 0, 2, 20) });
    const c = snap({ paint: { caretRect: R(2, 0, 2, 20), anchorRect: R(0, 0, 10, 20), anchorKey: '[]' } });
    expect(diffSnapshots(b, c).paint).toEqual({ anchorKey: '[]' });
  });

  it('a rejected input that changed nothing diffs to an empty diff (header + rejection only)', () => {
    const a = snap();
    const d: EntryDiffs = diffSnapshots(a, snap());
    expect(d).toEqual({});
    const e: TestEntry = { seq: 3, t: 1, input: { kind: 'key', type: 'keydown', key: '1', code: 'Digit1', mods: '' }, rejection: { kind: 'validation', name: 'ValidationError', message: 'm' }, ...d };
    expect(Object.keys(e).sort()).toEqual(['input', 'rejection', 'seq', 't']);
  });
});

describe('logger-core — mechanical no-op flag (derived, pure, injected rects)', () => {
  it('caret-only diff → flagged (the twin/seam family)', () => {
    expect(deriveMechanicalNoop({ caret: { kind: 'row', path: [], index: 2 } })).toBe(true);
  });

  it('caret + caret-rect diff (injected rects differ) → NOT flagged', () => {
    expect(deriveMechanicalNoop({ caret: { kind: 'token', path: [0], index: 0 }, caretRect: R(14) })).toBe(false);
    // same caret state but the rect field present at all → not a pure caret-only entry
    expect(deriveMechanicalNoop({ caret: { kind: 'empty' }, caretRect: R(10) })).toBe(false);
  });

  it('any tree/mathml/rects/styles/paint diff alongside caret → NOT flagged', () => {
    const caret = { kind: 'empty' };
    expect(deriveMechanicalNoop({ caret, ast: { v: 1, root: null } })).toBe(false);
    expect(deriveMechanicalNoop({ caret, mathml: '<math/>' })).toBe(false);
    expect(deriveMechanicalNoop({ caret, rects: { math: R(1) } })).toBe(false);
    expect(deriveMechanicalNoop({ caret, styles: { math: { color: 'red' } } })).toBe(false);
    expect(deriveMechanicalNoop({ caret, paint: { anchorKey: 'math' } })).toBe(false);
  });

  it('header-only entries (rejected / silent no-op input) are NOT flagged', () => {
    expect(deriveMechanicalNoop({})).toBe(false);
  });

  it('the baseline (all fields full) is NOT flagged', () => {
    const d = diffSnapshots(null, snap());
    expect(deriveMechanicalNoop(d)).toBe(false);
  });
});

describe('logger-core — resolveAt (state in effect at entry N)', () => {
  const base = entry(0, diffSnapshots(null, snap()));
  const caretMove = entry(1, { input: { kind: 'key', type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', mods: '' }, caret: { kind: 'token', path: [0], index: 0 } });
  const noChange = entry(2, { input: { kind: 'key', type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', mods: '' } }); // header only
  const treeChange = entry(3, {
    input: { kind: 'key', type: 'keydown', key: '5', code: 'Digit5', mods: '' },
    caret: { kind: 'token', path: [0], index: 1 },
    caretRect: R(14),
    ast: { v: 1, root: { type: 'num', value: 5 } },
    mathml: '<math><mn>5</mn></math>',
    rects: { math: R(0, 0, 100, 20), '[]': R(2, 0, 8, 20), 'gone': null },
    styles: { '[]': { color: 'rgb(5, 5, 5)' } },
  });
  const entries = [base, caretMove, noChange, treeChange];

  it('resolves each field as its most recent value at or before N', () => {
    expect(resolveAt(entries, 0).caret).toEqual(base.caret);
    expect(resolveAt(entries, 1).caret).toEqual(caretMove.caret);
    expect(resolveAt(entries, 2).caret).toEqual(caretMove.caret); // header-only entry changes nothing
    expect(resolveAt(entries, 3).caret).toEqual(treeChange.caret);
    expect(resolveAt(entries, 3).caretRect).toEqual(R(14));
    expect(resolveAt(entries, 2).caretRect).toEqual(base.caretRect); // look-back over the no-change entry
    expect(resolveAt(entries, 3).ast).toEqual(treeChange.ast);
    expect(resolveAt(entries, 2).ast).toEqual(base.ast);
    expect(resolveAt(entries, 3).mathml).toBe('<math><mn>5</mn></math>');
  });

  it('entries that change nothing themselves resolve to the previous state (rects/styles cumulative, null deletes)', () => {
    const r3 = resolveAt(entries, 3);
    expect(r3.rects['[]']).toEqual(R(2, 0, 8, 20));
    expect('gone' in r3.rects).toBe(false);
    expect(r3.rects.math).toEqual(base.rects!.math); // unchanged key carries over
    expect(r3.styles['[]']).toEqual({ color: 'rgb(5, 5, 5)' });
    expect(r3.styles.math).toEqual(base.styles!.math); // untouched element carries over
    expect(resolveAt(entries, 2).rects).toEqual(base.rects);
  });

  it('rejects a log whose first entry is not a full baseline', () => {
    expect(() => resolveAt([entry(0, { caret: { kind: 'empty' } })], 0)).toThrow(/baseline/);
    expect(() => resolveAt([], 0)).toThrow(/empty/);
  });
});

describe('logger-core — storage + export serialization (the bug file)', () => {
  const rec: StoredRecording = {
    id: 'rec-1',
    title: 'twin at the unit seam',
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:01:00.000Z',
    paintGeometry: false,
    entries: [
      entry(0, diffSnapshots(null, snap())),
      entry(1, { input: { kind: 'key', type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', mods: '' }, caret: { kind: 'token', path: [0], index: 0 } }),
      entry(2, { input: { kind: 'key', type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft', mods: '' }, caret: { kind: 'token', path: [0], index: 2 } }),
    ],
    comments: { '2': 'the twin step — caret paints but nothing else moved' },
  };

  it('storage round-trips; parse rejects foreign shapes', () => {
    const text = serializeStorage({ version: LOG_VERSION, recordings: [rec] });
    const back = parseStorage(text);
    expect(back.recordings[0].entries.length).toBe(3);
    expect(back.recordings[0].comments['2']).toContain('twin');
    expect(() => parseStorage('{"version":99,"recordings":[]}')).toThrow();
    expect(() => parseStorage('nope')).toThrow();
  });

  it('the stored entries carry NO derived flag; the export derives mechanicalNoop and merges the comment', () => {
    const raw = serializeStorage({ version: LOG_VERSION, recordings: [rec] });
    expect(raw).not.toContain('mechanicalNoop');
    const file = parseLogFile(serializeBugFile(rec, '2026-11-12T11:00:00.000Z'));
    expect(file.format).toBe(LOG_FORMAT);
    expect(file.version).toBe(LOG_VERSION);
    expect(file.kind).toBe('bug');
    const entries = file.entries as Record<string, unknown>[];
    expect(entries[0].mechanicalNoop).toBe(false); // baseline
    expect(entries[1].mechanicalNoop).toBe(true); // caret-only twin
    expect(entries[2].mechanicalNoop).toBe(true);
    expect(entries[2].comment).toBe('the twin step — caret paints but nothing else moved');
    expect('comment' in entries[1]).toBe(false);
  });

  it('exportEntry derives the flag from the diffs alone', () => {
    expect(exportEntry(entry(5, { caret: { kind: 'empty' } })).mechanicalNoop).toBe(true);
    expect(exportEntry(entry(5, { caret: { kind: 'empty' }, caretRect: R(3) })).mechanicalNoop).toBe(false);
    expect(exportEntry(entry(5, {})).mechanicalNoop).toBe(false);
  });

  it('cluster export (export-all) wraps every recording; parseLogFile is schema-stable', () => {
    const cluster = parseLogFile(serializeClusterFile([rec, { ...rec, id: 'rec-2' }], '2026-11-12T11:00:00.000Z'));
    expect(cluster.kind).toBe('cluster');
    expect((cluster.recordings as unknown[]).length).toBe(2);
    expect(() => parseLogFile(JSON.stringify({ format: 'other', version: 1 }))).toThrow(/integral-testlog/);
    expect(() => parseLogFile(JSON.stringify({ format: LOG_FORMAT, version: 999 }))).toThrow();
  });

  it('bugFile/clusterFile object shapes match the serialized text', () => {
    expect(bugFile(rec, 'x').entries).toHaveLength(3);
    expect(clusterFile([rec], 'x').recordings).toHaveLength(1);
  });
});

describe('logger-core — inputSummary', () => {
  it('summarizes each input kind', () => {
    expect(inputSummary({ kind: 'record-start' })).toBe('record start');
    expect(inputSummary({ kind: 'key', type: 'keydown', key: '5', code: 'Digit5', mods: '' })).toBe('keydown "5"');
    expect(inputSummary({ kind: 'key', type: 'keydown', key: 'z', code: 'KeyZ', mods: 'C' })).toBe('keydown "z" [C]');
    expect(inputSummary({ kind: 'click', x: 3, y: 4, target: '[]' })).toBe('click []');
    expect(inputSummary({ kind: 'case-load', caseId: 'K-17' })).toBe('case load K-17');
  });
});
