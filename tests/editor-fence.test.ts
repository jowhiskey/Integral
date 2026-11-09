// @vitest-environment jsdom
// The fence element map (rework session 3): every rendered fence glyph — the
// group/fn OPEN parens, the container CLOSE parens (rendered by the container
// itself, which is exactly why they had no addressable element before), and
// the dangling fence-node close tokens — is bound to its owning node + side;
// a close:false container renders NO close element and appears in the
// missing-close inventory instead. The map is pure rendering data: nothing in
// the markup changes (the builder-vs-toMathML parity pin lives in
// editor-render.test.ts and stays untouched).

import { describe, expect, it } from 'vitest';

import { fromJSON } from '../src/ast/serialize.js';

import { buildMathML, pathKey } from '../src/editor/mathml-dom.js';

const doc = () => document;

const sym = (name: string) => ({ type: 'sym', name });
const op = (name: string, ...args: (unknown | null)[]) => ({ type: 'op', op: name, args });
const fn = (name: string, args: (unknown | null)[], close = true) =>
  ({ type: 'fn', name, args, ...(close ? {} : { close: false }) });
const group = (child: unknown, close = true) =>
  ({ type: 'group', parens: 'always', child, ...(close ? {} : { close: false }) });
const fence = () => ({ type: 'fence', side: 'close' });

const glyphSet = (seed: unknown): Set<string> => {
  const rendered = buildMathML(fromJSON({ v: 1, root: seed }), doc());
  return new Set([...rendered.fenceGlyphs.entries()].map(([el, info]) =>
    JSON.stringify([el.textContent, info.path, info.side])));
};

describe('the fence element map — glyph coverage (rework session 3)', () => {
  it('a group binds BOTH its glyphs: open + close, owned by the group node path', () => {
    expect(glyphSet(group(op('add', sym('a'), sym('b'))))).toEqual(new Set([
      JSON.stringify(['(', [], 'open']),
      JSON.stringify([')', [], 'close']),
    ]));
  });

  it('a function binds its open paren and its container-rendered close paren (the previously unaddressable glyph)', () => {
    expect(glyphSet(fn('sin', [sym('a')]))).toEqual(new Set([
      JSON.stringify(['(', [], 'open']),
      JSON.stringify([')', [], 'close']),
    ]));
  });

  it('nested + in-row containers bind through their full paths; a dangling fence node binds its own close glyph', () => {
    expect(glyphSet(op('add', sym('x'), group(sym('a')), fn('cos', [sym('b')]), fence()))).toEqual(new Set([
      JSON.stringify(['(', [1], 'open']),
      JSON.stringify([')', [1], 'close']),
      JSON.stringify(['(', [2], 'open']),
      JSON.stringify([')', [2], 'close']),
      JSON.stringify([')', [3], 'close']),
    ]));
  });

  it('a group child row held inline keeps its fence binding on the group (the hosted-inline case)', () => {
    expect(glyphSet(group(op('add', sym('a'), sym('b'))))).toContain(JSON.stringify(['(', [], 'open']));
  });
});

describe('the fence element map — the missing-close states (close:false)', () => {
  it('close:false containers record the state bound to their own container element; no close glyph renders', () => {
    const seed = op('multiply', group(sym('a'), false), fn('sin', [sym('b')], false));
    const rendered = buildMathML(fromJSON({ v: 1, root: seed }), doc());
    expect(rendered.fencesMissingClose.size).toBe(2);
    expect(rendered.fencesMissingClose.has(pathKey([0]))).toBe(true);
    expect(rendered.fencesMissingClose.has(pathKey([1]))).toBe(true);
    const owner = rendered.fencesMissingClose.get(pathKey([0]));
    expect(owner?.querySelectorAll('[fence="true"]').length).toBe(1); // only the open glyph remains
    expect([...rendered.fenceGlyphs.values()].filter((f) => f.side === 'close').length).toBe(0);
    expect([...rendered.fenceGlyphs.values()].filter((f) => f.side === 'open').length).toBe(2);
  });

  it('an unbalanced seed with one closed and one open container splits the inventories cleanly at the same depth', () => {
    const seed = op('add', group(sym('a')), group(sym('b'), false));
    const rendered = buildMathML(fromJSON({ v: 1, root: seed }), doc());
    expect([...rendered.fenceGlyphs.values()].filter((f) => f.side === 'close')).toEqual([{ path: [0], side: 'close' }]);
    expect(rendered.fencesMissingClose.has(pathKey([1]))).toBe(true);
  });
});

describe('the fence element map is pure rendering data (no markup drift)', () => {
  it('the mapped glyph elements are the very mo children the builder already produced — no ids, classes, or attributes added', () => {
    const rendered = buildMathML(fromJSON({ v: 1, root: fn('sin', [sym('a')]) }), doc());
    for (const [el] of rendered.fenceGlyphs) {
      expect(el.tagName).toBe('mo');
      expect(el.getAttribute('fence')).toBe('true');
      expect(el.getAttribute('id')).toBe(null);
      expect(el.getAttribute('class')).toBe(null);
      expect(el.hasAttribute('class')).toBe(false);
    }
    // the builder parity pin lives in editor-render.test.ts and is untouched —
    // this suite adds no rendering behavior, only the map.
  });
});
