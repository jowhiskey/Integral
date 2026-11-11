// @vitest-environment jsdom
// Editor renderer corpus: envelopes through fromJSON (all 10 node types, null
// slots, empty-string fields, empty formula, omitted root index) → built DOM.
// Pins: per-type structure, exactly one uid element per AST node, document-wide
// uid uniqueness, unit mathvariant / fence="true" / placeholder conventions, and
// the parity pin (editor DOM tags+text == parsed toMathML(root)).

import { describe, expect, it } from 'vitest';

import { fromJSON, toMathML } from '../src/ast/index.js';
import { buildMathML, caretKey, pathKey } from '../src/editor/mathml-dom.js';
import { countNodes, shape } from './editor-support.js';

const num = (value: number) => ({ type: 'num', value }) as const;
const sym = (name: string) => ({ type: 'sym', name }) as const;

const CORPUS: Record<string, unknown> = {
  empty: { v: 1, root: null },
  omittedRoot: { v: 1 },
  num: { v: 1, root: num(42) },
  negNum: { v: 1, root: num(-3.5) },
  sym: { v: 1, root: sym('x') },
  emptySym: { v: 1, root: sym('') },
  hostileSym: { v: 1, root: sym('a<b&c') },
  sub: { v: 1, root: { type: 'sub', base: 'x', sub: 'max' } },
  emptySub: { v: 1, root: { type: 'sub', base: '', sub: '' } },
  opAdd3: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b'), sym('c')] } },
  opWithNullCell: { v: 1, root: { type: 'op', op: 'add', args: [num(5), null] } },
  emptyRow: { v: 1, root: { type: 'op', op: 'add', args: [] } },
  unary: { v: 1, root: { type: 'op', op: 'unaryMinus', args: [sym('x')] } },
  unaryEmpty: { v: 1, root: { type: 'op', op: 'unaryMinus', args: [null] } },
  powOp: { v: 1, root: { type: 'op', op: 'pow', args: [sym('x'), num(2)] } },
  powOpNullExp: { v: 1, root: { type: 'op', op: 'pow', args: [sym('x'), null] } },
  fn: { v: 1, root: { type: 'fn', name: 'sin', args: [sym('x'), num(0.5)] } },
  fnZeroArg: { v: 1, root: { type: 'fn', name: 'f', args: [] } },
  fnNullArg: { v: 1, root: { type: 'fn', name: 'f', args: [null] } },
  fnNullSecondArg: { v: 1, root: { type: 'fn', name: 'f', args: [sym('a'), null] } },
  group: { v: 1, root: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } } },
  groupNull: { v: 1, root: { type: 'group', parens: 'always', child: null } },
  groupUnit: { v: 1, root: { type: 'group', parens: 'always', child: { type: 'unit', value: num(50), unit: 'mm' } } },
  frac: {
    v: 1,
    root: {
      type: 'frac',
      num: {
        type: 'group',
        parens: 'always',
        child: { type: 'op', op: 'add', args: [num(5), { type: 'op', op: 'multiply', args: [num(4), num(3)] }] },
      },
      den: num(2),
    },
  },
  fracNull: { v: 1, root: { type: 'frac', num: null, den: null } },
  fracUnitNum: { v: 1, root: { type: 'frac', num: { type: 'unit', value: num(50), unit: 'mm' }, den: num(2) } },
  pow: { v: 1, root: { type: 'pow', base: sym('x'), exp: null } },
  root: { v: 1, root: { type: 'root', radicand: num(16) } },
  rootIndex: { v: 1, root: { type: 'root', radicand: sym('x'), index: num(3) } },
  rootNull: { v: 1, root: { type: 'root', radicand: null } },
  unit: { v: 1, root: { type: 'unit', value: num(50), unit: 'mm' } },
  unitEmptyName: { v: 1, root: { type: 'unit', value: num(50), unit: '' } },
  unitNullValue: { v: 1, root: { type: 'unit', value: null, unit: 'mm' } },
  unitInRow: { v: 1, root: { type: 'op', op: 'add', args: [{ type: 'unit', value: num(50), unit: 'mm' }, sym('a')] } },
  implicitRow: { v: 1, root: { type: 'op', op: 'multiply', args: [num(5), sym('x')], implicit: true } },
  implicitSeam: { v: 1, root: { type: 'op', op: 'multiply', args: [num(5), num(3)], implicit: true } },
  leadingNull: { v: 1, root: { type: 'op', op: 'subtract', args: [null, sym('x')] } },
  bareInterior: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), null, sym('b')] } },
  allNullRow: { v: 1, root: { type: 'op', op: 'add', args: [null, null] } },
  groupNoClose: { v: 1, root: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, close: false } },
  fnNoClose: { v: 1, root: { type: 'fn', name: 'sin', args: [sym('x')], close: false } },
  danglingFence: { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), { type: 'fence', side: 'close' }] } },
  displacedFence: {
    v: 1,
    root: {
      type: 'frac',
      num: { type: 'group', parens: 'always', child: { type: 'op', op: 'add', args: [sym('a'), sym('b')] }, close: false },
      den: { type: 'op', op: 'add', args: [num(2), { type: 'fence', side: 'close', open: ['num'] }] },
    },
  },
  mrootNullIndex: { v: 1, root: { type: 'root', radicand: num(2), mroot: true } },
  plainRootNullIndex: { v: 1, root: { type: 'root', radicand: num(2), index: null } },
  allTypes: {
    v: 1,
    root: {
      type: 'fn',
      name: 'round',
      args: [
        {
          type: 'op',
          op: 'add',
          args: [
            { type: 'pow', base: num(2), exp: { type: 'frac', num: num(1), den: num(2) } },
            { type: 'root', radicand: num(16), index: num(3) },
            { type: 'unit', value: num(9.81), unit: 'm' },
            { type: 'sub', base: 'x', sub: '1' },
            { type: 'group', parens: 'always', child: sym('y') },
          ],
        },
        { type: 'op', op: 'unaryMinus', args: [sym('z')] },
      ],
    },
  },
};

const NON_EMPTY = Object.entries(CORPUS).filter(([, env]) => fromJSON(env) !== null);

describe('editor renderer: per-type pinned structure', () => {
  const built = (name: string) => buildMathML(fromJSON(CORPUS[name]), document);

  it('empty formula → a single empty <math>, no uid elements', () => {
    const r = buildMathML(null, document);
    expect(shape(r.math)).toBe('<math></math>');
    expect(r.uidByPath.size).toBe(0);
  });

  it('num → <math><mn>…</mn></math>', () => {
    expect(shape(built('num').math)).toBe('<math><mn>#42</mn></math>');
  });

  it('sym with host characters → text is stored raw (DOM escapes on serialize)', () => {
    expect(shape(built('hostileSym').math)).toBe('<math><mi>#a<b&c</mi></math>');
  });

  it('sub → msub with two mi', () => {
    expect(shape(built('sub').math)).toBe('<math><msub><mi>#x</mi><mi>#max</mi></msub></math>');
  });

  it('n-ary add → one mrow, args joined by separator mo (no ids on the mo\'s)', () => {
    const r = built('opAdd3');
    expect(shape(r.math)).toBe('<math><mrow><mi>#a</mi><mo>#+</mo><mi>#b</mi><mo>#+</mo><mi>#c</mi></mrow></math>');
    expect(r.separators.size).toBe(2);
  });

  it('null op-row cell renders BARE (no placeholder) and registers a bare-cell anchor', () => {
    // Re-pinned (contract T7 split): row-level missing operands show NO □ —
    // □ is 2D-slot territory (frac/pow/root slots, fn args, group content).
    const r = built('opWithNullCell');
    expect(shape(r.math)).toBe('<math><mrow><mn>#5</mn><mo>#+</mo></mrow></math>');
    expect([...r.placeholders.values()].some((c) => c.kind === 'row' && c.path.length === 0)).toBe(false);
    const bare = r.bareAnchors.get(caretKey({ kind: 'row', path: [], index: 1 }));
    expect(bare).toBeDefined();
    expect(bare!.side).toBe('right'); // the preceding separator glyph's right edge
  });

  it('unary minus → mrow with leading mo and operand', () => {
    expect(shape(built('unary').math)).toBe('<math><mrow><mo>#−</mo><mi>#x</mi></mrow></math>');
    // Re-pinned (T7 split): the null cell of a unary row renders BARE — the
    // glyph stands alone; the caret anchors at its right edge.
    expect(shape(built('unaryEmpty').math)).toBe('<math><mrow><mo>#−</mo></mrow></math>');
    const r = built('unaryEmpty');
    const bare = r.bareAnchors.get(caretKey({ kind: 'row', path: [], index: 0 }));
    expect(bare).toBeDefined();
    expect(bare!.side).toBe('right');
  });

  it('2-arg pow op → msup like PowerNode', () => {
    expect(shape(built('powOp').math)).toBe('<math><msup><mi>#x</mi><mn>#2</mn></msup></math>');
    expect(shape(built('powOpNullExp').math)).toBe('<math><msup><mi>#x</mi><mi>#□</mi></msup></math>');
  });

  it('fn → mrow with name mi and fence="true" parens, commas between args', () => {
    const r = built('fn');
    expect(shape(r.math)).toBe('<math><mrow><mi>#sin</mi><mo>#(</mo><mi>#x</mi><mo>#,</mo><mn>#0.5</mn><mo>#)</mo></mrow></math>');
    const fences = [...r.math.querySelectorAll('mo')].filter((m) => m.getAttribute('fence') === 'true');
    expect(fences.map((m) => m.textContent)).toEqual(['(', ')']);
    expect(shape(built('fnZeroArg').math)).toBe('<math><mrow><mi>#f</mi><mo>#(</mo><mo>#)</mo></mrow></math>');
  });

  it('fn: an empty argument BEYOND the first renders BARE — no □ element, a bare-cell anchor at its comma (the owner\'s B-23 live ruling)', () => {
    const r = built('fnNullSecondArg');
    expect(shape(r.math)).toBe('<math><mrow><mi>#f</mi><mo>#(</mo><mi>#a</mi><mo>#,</mo><mo>#)</mo></mrow></math>');
    expect(r.placeholders.size).toBe(0);
    expect(r.bareAnchors.get(caretKey({ kind: 'row', path: [], index: 1 }))).toBeDefined();
  });

  it('group → mrow with fence="true" parens; flat op child inlines (one mrow)', () => {
    const r = built('group');
    expect(shape(r.math)).toBe('<math><mrow><mo>#(</mo><mi>#a</mi><mo>#+</mo><mi>#b</mi><mo>#)</mo></mrow></math>');
    const fences = [...r.math.querySelectorAll('mo')].filter((m) => m.getAttribute('fence') === 'true');
    expect(fences.map((m) => m.textContent)).toEqual(['(', ')']);
    expect(shape(built('groupNull').math)).toBe('<math><mrow><mo>#(</mo><mi>#□</mi><mo>#)</mo></mrow></math>');
  });

  it('frac → mfrac with exactly one child element per slot', () => {
    expect(shape(built('fracNull').math)).toBe('<math><mfrac><mi>#□</mi><mi>#□</mi></mfrac></math>');
    const mfrac = built('frac').math.firstElementChild!;
    expect(mfrac.localName).toBe('mfrac');
    expect(mfrac.childElementCount).toBe(2);
  });

  it('unit in a frac slot (multi-element fragment) → wrapped in a single mrow', () => {
    const mfrac = built('fracUnitNum').math.firstElementChild!;
    expect(mfrac.childElementCount).toBe(2);
    expect(mfrac.firstElementChild!.localName).toBe('mrow');
  });

  it('pow → msup; root → msqrt (index omitted) / mroot (index present); null radicand → □', () => {
    expect(shape(built('pow').math)).toBe('<math><msup><mi>#x</mi><mi>#□</mi></msup></math>');
    expect(shape(built('root').math)).toBe('<math><msqrt><mn>#16</mn></msqrt></math>');
    expect(shape(built('rootIndex').math)).toBe('<math><mroot><mi>#x</mi><mn>#3</mn></mroot></math>');
    expect(shape(built('rootNull').math)).toBe('<math><msqrt><mi>#□</mi></msqrt></math>');
  });

  it('unit → value + thin mspace + upright mathvariant="normal" mi; empty unit → no mspace', () => {
    const r = built('unit');
    expect(shape(r.math)).toBe('<math><mrow><mn>#50</mn><mspace></mspace><mi>#mm</mi></mrow></math>');
    const mspace = r.math.querySelector('mspace')!;
    expect(mspace.getAttribute('width')).toBe('0.1667em');
    const label = [...r.math.querySelectorAll('mi')].find((m) => m.textContent === 'mm')!;
    expect(label.getAttribute('mathvariant')).toBe('normal');
    // the unit's OWN element is the upright label mi (the value is a child node)
    expect(r.elementByPath.get(pathKey([]))!.textContent).toBe('mm');
    expect(r.elementByPath.get(pathKey(['value']))!.textContent).toBe('50');

    const empty = built('unitEmptyName');
    expect(empty.math.querySelector('mspace')).toBeNull();
    const label2 = [...empty.math.querySelectorAll('mi')].find((m) => m.getAttribute('mathvariant') === 'normal')!;
    expect(label2.textContent).toBe('');
  });

  it('unit as a row arg → loose siblings inside the row mrow (no extra wrap)', () => {
    expect(shape(built('unitInRow').math)).toBe(
      '<math><mrow><mn>#50</mn><mspace></mspace><mi>#mm</mi><mo>#+</mo><mi>#a</mi></mrow></math>',
    );
  });

  it('contract state shapes (rework session 1): implicit rows, bare cells, fences, empty mroot index', () => {
    // Implicit multiply: NO separator glyphs; the row's own mrow only.
    const i5x = built('implicitRow');
    expect(shape(i5x.math)).toBe('<math><mrow><mn>#5</mn><mi>#x</mi></mrow></math>');
    expect(i5x.separators.size).toBe(0);
    // S-098 seam: the classed mspace renders between the two numbers. It
    // carries explicit height/depth (rework 2b-1 — mspace defaults to height
    // 0, which paints nothing for a background tint; the element itself is
    // the visible box now, mirroring the string renderer's SEAM_MARKER bytes).
    const seam = built('implicitSeam');
    expect(shape(seam.math)).toBe('<math><mrow><mn>#5</mn><mspace></mspace><mn>#3</mn></mrow></math>');
    const seamEl = seam.math.querySelector('mspace')!;
    expect(seamEl.getAttribute('class')).toBe('integral-seam');
    expect(seamEl.getAttribute('width')).toBe('0.1667em');
    expect(seamEl.getAttribute('height')).toBe('0.75em');
    expect(seamEl.getAttribute('depth')).toBe('0.2em');
    // Bare rows: null cells emit NO placeholder element, but get caret anchors.
    expect(shape(built('leadingNull').math)).toBe('<math><mrow><mo>#−</mo><mi>#x</mi></mrow></math>');
    expect(built('leadingNull').placeholders.size).toBe(0);
    expect(built('leadingNull').bareAnchors.get(caretKey({ kind: 'row', path: [], index: 0 }))).toBeDefined();
    expect(shape(built('bareInterior').math)).toBe('<math><mrow><mi>#a</mi><mo>#+</mo><mo>#+</mo><mi>#b</mi></mrow></math>');
    expect(shape(built('allNullRow').math)).toBe('<math><mrow><mo>#+</mo></mrow></math>');
    expect(built('allNullRow').bareAnchors.size).toBe(2);
    // Movable fences: open rows stand open; close tokens are fenced mo's.
    expect(shape(built('groupNoClose').math)).toBe('<math><mrow><mo>#(</mo><mi>#a</mi><mo>#+</mo><mi>#b</mi></mrow></math>');
    expect(shape(built('fnNoClose').math)).toBe('<math><mrow><mi>#sin</mi><mo>#(</mo><mi>#x</mi></mrow></math>');
    expect(shape(built('danglingFence').math)).toBe('<math><mrow><mi>#x</mi><mo>#+</mo><mo>#)</mo></mrow></math>');
    expect(shape(built('displacedFence').math)).toBe(
      '<math><mfrac><mrow><mo>#(</mo><mi>#a</mi><mo>#+</mo><mi>#b</mi></mrow><mrow><mn>#2</mn><mo>#+</mo><mo>#)</mo></mrow></mfrac></math>',
    );
    // mroot keeps its index slot (with placeholder) when the index is empty.
    expect(shape(built('mrootNullIndex').math)).toBe('<math><mroot><mn>#2</mn><mi>#□</mi></mroot></math>');
    // ... while a null index WITHOUT the flag stays the v1 square root.
    expect(shape(built('plainRootNullIndex').math)).toBe('<math><msqrt><mn>#2</mn></msqrt></math>');
  });
});

describe('editor renderer: one uid element per AST node, document-wide unique ids', () => {
  it('every corpus envelope: uid count == AST node count, ids unique across the document', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let total = 0;
    for (const [name, env] of Object.entries(CORPUS)) {
      const root = fromJSON(env);
      const rendered = buildMathML(root, document);
      host.appendChild(rendered.math);
      const nodes = countNodes((env as { root?: unknown }).root ?? null);
      total += nodes;
      const idEls = rendered.math.querySelectorAll('[id]');
      expect(rendered.uidByPath.size, name).toBe(nodes);
      expect(rendered.elementByPath.size, name).toBe(nodes);
      expect(idEls.length, name).toBe(nodes);
      for (const [key, uid] of rendered.uidByPath) {
        expect(rendered.elementByPath.get(key)!.getAttribute('id'), name).toBe(uid);
        expect(rendered.pathByUid.get(uid), name).toEqual(JSON.parse(key));
      }
    }
    // document-wide uid uniqueness across every build of this test
    const ids = [...host.querySelectorAll('[id]')].map((e) => e.getAttribute('id')!);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total);
  });

  it('ids stay unique across separate builds appended to the same document', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r1 = buildMathML(fromJSON(CORPUS.allTypes), document);
    const r2 = buildMathML(fromJSON(CORPUS.opAdd3), document);
    host.appendChild(r1.math);
    host.appendChild(r2.math);
    const ids = [...host.querySelectorAll('[id]')].map((e) => e.getAttribute('id')!);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(countNodes((CORPUS.allTypes as { root: unknown }).root) + countNodes((CORPUS.opAdd3 as { root: unknown }).root));
  });
});

describe('editor renderer: parity pin — editor DOM (tags+text) == parsed toMathML(root)', () => {
  it('every non-empty corpus envelope matches the AST string output', () => {
    const parser = new DOMParser();
    for (const [name, env] of NON_EMPTY) {
      const root = fromJSON(env);
      const rendered = buildMathML(root, document);
      const parsed = parser.parseFromString(toMathML(root), 'text/html');
      const parsedMath = parsed.body.firstElementChild;
      expect(parsedMath, name).not.toBeNull();
      expect(shape(rendered.math), name).toBe(shape(parsedMath!));
    }
  });

  it('empty formula: toMathML is the empty string; the editor renders one empty <math>', () => {
    expect(toMathML(null)).toBe('');
    expect(shape(buildMathML(null, document).math)).toBe('<math></math>');
  });
});
