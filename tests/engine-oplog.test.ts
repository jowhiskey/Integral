// Op-log host exposure (engine half): the versioned OpLog serialization.
// serializeOpLog replays each undo unit op-by-op from the unit's own pre-unit
// snapshot and pairs every op with a compact reverse step (RevOp), so
// invert(op) restores the pre-op envelope AND caret from the log alone.
// Pins: format v1, plain JSON data, per-op invertibility across the whole op
// vocabulary (incl. the null-cell splice and the occupied replaces the
// forward deleteAt cannot invert), a mixed-unit walk-back, a full walk-back
// to the session's initial envelope, forward replay round-trip, the fromJSON
// gate on applyRevOp, and pure movement never entering the log.

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';
import { ValidationError } from '../src/ast/validation.js';
import {
  applyOp,
  applyOps,
  applyRevOp,
  envelopeOf,
  EngineError,
  initSession,
  revOfOp,
  serializeOpLog,
  type Caret,
  type EditingState,
  type Envelope,
  type Op,
} from '../src/engine/index.js';

const j = (x: unknown): string => JSON.stringify(x);
const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;

/** Apply one op as its own undo unit and pin the inversion of exactly that
 *  op: applyRevOp on the post-op envelope with the serialized rev restores
 *  the pre-op envelope byte-exactly, and the rev's caret restores the pre-op
 *  caret. */
function step(s: EditingState, op: Op): EditingState {
  const next = applyOp(s, op);
  const log = serializeOpLog(next);
  const entry = log.entries[log.entries.length - 1];
  const sop = entry.ops[entry.ops.length - 1];
  expect(sop.op).toEqual(op);
  expect(j(applyRevOp(envelopeOf(next), sop.rev, s.vocabulary))).toBe(j(entry.before));
  expect(j(entry.before)).toBe(j(envelopeOf(s)));
  expect(j(sop.rev.caret)).toBe(j(entry.caretBefore));
  expect(j(entry.caretBefore)).toBe(j(s.caret));
  return next;
}

describe('op log v1 — serialization shape and plain-data pins', () => {
  it('a fresh session serializes to an empty v1 log', () => {
    const log = serializeOpLog(initSession());
    expect(log.v).toBe(1);
    expect(log.entries).toEqual([]);
  });

  it('the serialized log is plain JSON data (byte-exact round-trip) and mirrors the runtime log', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: num(5), at: { at: 'root' } });
    s = applyOp(s, {
      op: 'insert',
      node: { type: 'op', op: 'multiply', args: [num(2), null], implicit: true },
      at: { at: 'replaceRoot' },
    });
    s = applyOp(s, { op: 'moveCaret', to: { kind: 'row', path: [], index: 1 } });
    const log = serializeOpLog(s);
    expect(log.v).toBe(1);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
    expect(log.entries.length).toBe(s.log.length);
    for (let i = 0; i < s.log.length; i++) {
      expect(log.entries[i].ops.map((x) => x.op)).toEqual([...s.log[i].ops]);
      expect(log.entries[i].before).toEqual(s.log[i].before);
      expect(log.entries[i].caretBefore).toEqual(s.log[i].caretBefore);
    }
  });

  it('pure movement never enters the log (move-only units are not serialized)', () => {
    let s = initSession({ v: 1, root: { type: 'op', op: 'add', args: [num(5), num(3)] } });
    const moved = applyOp(s, { op: 'move', dir: 'left' });
    expect(moved.log).toBe(s.log);
    expect(serializeOpLog(moved)).toEqual(serializeOpLog(s));
  });
});

describe('revOfOp — the reverse step derived from the pre-op state', () => {
  it('replace carries the displaced occupant, deleteAt the removed node, movement only a caret', () => {
    const pre: Envelope = { v: 1, root: { type: 'frac', num: num(1), den: num(2) } };
    const caret: Caret = { kind: 'node', path: [] };
    expect(revOfOp({ op: 'insert', node: sym('x'), at: { at: 'replaceSlot', path: [], slot: 'num' } }, pre, caret)).toEqual({
      rev: 'revReplace',
      at: { at: 'replaceSlot', path: [], slot: 'num' },
      prev: num(1),
      caret,
    });
    expect(revOfOp({ op: 'deleteAt', at: { at: 'slot', path: [], slot: 'den' } }, pre, caret)).toEqual({
      rev: 'revInsert',
      at: { at: 'slot', path: [], slot: 'den' },
      node: num(2),
      caret,
    });
    expect(revOfOp({ op: 'insert', node: null, at: { at: 'row', path: [], index: 0 } }, pre, caret)).toEqual({
      rev: 'revDelete',
      at: { at: 'row', path: [], index: 0 },
      caret,
    });
    expect(revOfOp({ op: 'move', dir: 'left' }, pre, caret)).toEqual({ rev: 'revCaret', caret });
    expect(revOfOp({ op: 'moveCaret', to: caret }, pre, caret)).toEqual({ rev: 'revCaret', caret });
  });
});

describe('per-op invertibility across the op vocabulary', () => {
  it('applyRevOp(post-op envelope, rev) === pre-op envelope and caret for every op kind', () => {
    let s = initSession();
    s = step(s, { op: 'insert', node: { type: 'frac', num: null, den: null }, at: { at: 'root' } }); // insert at root
    s = step(s, { op: 'insert', node: num(1), at: { at: 'slot', path: [], slot: 'num' } }); // insert into an empty slot
    s = step(s, { op: 'insert', node: num(2), at: { at: 'slot', path: [], slot: 'den' } });
    s = step(s, { op: 'deleteAt', at: { at: 'slot', path: [], slot: 'den' } }); // deleteAt on a slot
    s = step(s, { op: 'insert', node: sym('x'), at: { at: 'replaceSlot', path: [], slot: 'num' } }); // occupied replace on a slot
    s = step(s, { op: 'insert', node: { type: 'group', parens: 'always', child: null }, at: { at: 'replaceRoot' } }); // replaceRoot
    s = step(s, { op: 'place', node: num(8), at: { at: 'slot', path: [], slot: 'child' }, to: { kind: 'node', path: ['child'] } }); // place
    s = step(s, { op: 'insert', node: { type: 'op', op: 'add', args: [null] }, at: { at: 'replaceRoot' } }); // swap the root for a row with a pending cell
    s = step(s, { op: 'insert', node: num(5), at: { at: 'fill', path: [], index: 0 } }); // fill the null cell
    s = step(s, { op: 'insert', node: num(3), at: { at: 'row', path: [], index: 1 } }); // row splice
    s = step(s, { op: 'deleteAt', at: { at: 'row', path: [], index: 0 } }); // deleteAt on a row cell
    s = step(s, { op: 'insert', node: null, at: { at: 'row', path: [], index: 1 } }); // null-cell splice
    s = step(s, { op: 'insert', node: sym('y'), at: { at: 'replaceCell', path: [], index: 0 } }); // occupied replace on a cell
    s = step(s, { op: 'moveCaret', to: { kind: 'row', path: [], index: 2 } }); // logged caret unit
    s = step(s, { op: 'deleteAt', at: { at: 'root' } }); // deleteAt at root empties the formula
    expect(envelopeOf(s).root).toBe(null);
  });

  it('the null-cell splice inverts via revDelete where the forward deleteAt rejects', () => {
    let s = initSession();
    s = applyOp(s, { op: 'insert', node: { type: 'op', op: 'add', args: [num(5)] }, at: { at: 'root' } });
    s = applyOp(s, { op: 'insert', node: null, at: { at: 'row', path: [], index: 1 } }); // args [5, null]
    const log = serializeOpLog(s);
    const entry = log.entries[log.entries.length - 1];
    expect(entry.ops[0].rev.rev).toBe('revDelete');
    // the forward deleteAt rejects the null cell…
    expect(() => applyOp(s, { op: 'deleteAt', at: { at: 'row', path: [], index: 1 } })).toThrow(EngineError);
    // …while the serialized rev splices it back out, restoring the pre-op envelope
    expect(j(applyRevOp(envelopeOf(s), entry.ops[0].rev, s.vocabulary))).toBe(j(entry.before));
  });

  it('a mixed unit (move + insert) carries a revCaret for the move; walking the unit back op-by-op restores the pre-unit state', () => {
    const SEED: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [num(5), num(3)] } };
    const s = initSession(SEED);
    const mixed = applyOps(s, [
      { op: 'move', dir: 'left' },
      { op: 'insert', node: sym('z'), at: { at: 'row', path: [], index: 1 } },
    ]);
    expect(mixed.log.length).toBe(s.log.length + 1);
    const log = serializeOpLog(mixed);
    const entry = log.entries[log.entries.length - 1];
    expect(entry.ops.length).toBe(2);
    expect(entry.ops[0].op.op).toBe('move');
    expect(entry.ops[0].rev).toEqual({ rev: 'revCaret', caret: entry.caretBefore });
    let env = envelopeOf(mixed);
    let caret: Caret = mixed.caret;
    for (let i = entry.ops.length - 1; i >= 0; i--) {
      env = applyRevOp(env, entry.ops[i].rev, s.vocabulary);
      caret = entry.ops[i].rev.caret;
    }
    expect(j(env)).toBe(j(entry.before));
    expect(j(env)).toBe(j(envelopeOf(s)));
    expect(j(caret)).toBe(j(s.caret));
  });
});

describe('whole-log walks', () => {
  const SEED: Envelope = { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } };

  function built(): EditingState {
    let s = initSession(SEED);
    s = applyOp(s, { op: 'insert', node: num(5), at: { at: 'row', path: [], index: 2 } });
    s = applyOps(s, [
      { op: 'insert', node: sym('c'), at: { at: 'row', path: [], index: 3 } },
      { op: 'insert', node: null, at: { at: 'row', path: [], index: 4 } }, // null-cell splice inside a coalesced unit
    ]);
    s = applyOp(s, { op: 'deleteAt', at: { at: 'row', path: [], index: 0 } });
    s = applyOp(s, { op: 'insert', node: { type: 'frac', num: num(1), den: null }, at: { at: 'replaceRoot' } });
    s = applyOp(s, { op: 'moveCaret', to: { kind: 'slot', path: [], slot: 'den' } });
    return s;
  }

  it('a full walk-back over the serialized log lands on the session’s initial envelope, entry by entry', () => {
    const s = built();
    const log = serializeOpLog(s);
    expect(log.v).toBe(1);
    expect(log.entries.length).toBe(5);
    expect(j(log.entries[0].before)).toBe(j(SEED)); // the first unit's snapshot IS the session-initial envelope
    let env = envelopeOf(s);
    let caret: Caret = s.caret;
    for (let e = log.entries.length - 1; e >= 0; e--) {
      const entry = log.entries[e];
      for (let i = entry.ops.length - 1; i >= 0; i--) {
        env = applyRevOp(env, entry.ops[i].rev, s.vocabulary);
        caret = entry.ops[i].rev.caret;
      }
      expect(j(env)).toBe(j(entry.before)); // each unit boundary restores byte-exactly
      expect(j(caret)).toBe(j(entry.caretBefore));
    }
    expect(j(env)).toBe(j(SEED));
  });

  it('forward replay from the log alone (initial envelope + ops) reproduces the session byte-exactly', () => {
    const s = built();
    const log = serializeOpLog(s);
    let cur: EditingState = {
      root: fromJSON(log.entries[0].before, s.vocabulary),
      caret: log.entries[0].caretBefore,
      log: [],
      redo: [],
      vocabulary: s.vocabulary,
    };
    for (const entry of log.entries) {
      for (const sop of entry.ops) cur = applyOp(cur, sop.op);
    }
    expect(j(envelopeOf(cur))).toBe(j(envelopeOf(s)));
    expect(j(cur.caret)).toBe(j(s.caret));
  });
});

describe('applyRevOp guards', () => {
  it('gates its result through the contract boundary (typed error on a garbage rev payload)', () => {
    expect(() =>
      applyRevOp({ v: 1, root: null }, {
        rev: 'revInsert',
        at: { at: 'root' },
        node: { type: 'bogus' } as never,
        caret: { kind: 'empty' },
      }),
    ).toThrow(ValidationError);
  });

  it('revCaret touches no tree (the envelope comes back as-is); a replace position under revDelete is a typed mismatch', () => {
    const env: Envelope = { v: 1, root: null };
    expect(applyRevOp(env, { rev: 'revCaret', caret: { kind: 'empty' } })).toBe(env);
    expect(() =>
      applyRevOp({ v: 1, root: num(5) }, {
        rev: 'revDelete',
        at: { at: 'replaceRoot' } as never,
        caret: { kind: 'node', path: [] },
      }),
    ).toThrow(EngineError);
  });
});
