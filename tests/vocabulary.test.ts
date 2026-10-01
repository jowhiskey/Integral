import { describe, expect, it } from 'vitest';
import { Unit, create, all, evaluate, parse } from 'mathjs';
import {
  defaultStaticVocabulary,
  fromJSON,
  isParserShadowed,
  isUnitSymbolShape,
  type ContextualVocabulary,
  type StaticVocabulary,
} from '../src/ast/index.js';

describe('vocabulary interface', () => {
  it('default static vocabulary covers the standard mathjs set', () => {
    expect(defaultStaticVocabulary.constants).toEqual(['pi', 'tau', 'e', 'phi', 'i', 'Infinity', 'NaN']);
    for (const name of defaultStaticVocabulary.constants) {
      expect(() => evaluate(name)).not.toThrow();
    }
    expect(defaultStaticVocabulary.units).toContain('m');
    expect(defaultStaticVocabulary.units).toContain('g');
    expect(defaultStaticVocabulary.units).toContain('s');
    expect(defaultStaticVocabulary.functions).toContain('sin');
    expect(defaultStaticVocabulary.functions).toContain('add');
    expect(defaultStaticVocabulary.functions).toContain('sqrt');
    expect(new Set(defaultStaticVocabulary.units).size).toBe(defaultStaticVocabulary.units.length);
  });

  it('default units list includes prefixed forms (prefix x base)', () => {
    for (const prefixed of ['km', 'cm', 'mm', 'kg', 'kN', 'MPa']) {
      expect(defaultStaticVocabulary.units).toContain(prefixed);
    }
  });

  it('every default unit entry is recognized by mathjs as a valueless unit', () => {
    for (const entry of defaultStaticVocabulary.units) {
      expect(Unit.isValuelessUnit(entry)).toBe(true);
    }
  });

  it('default units list size is plausible (derived, not empty or exploded)', () => {
    const baseCount = Object.keys(Unit.UNITS).length;
    // Prefix expansion must multiply the base set substantially...
    expect(defaultStaticVocabulary.units.length).toBeGreaterThan(baseCount * 4);
    // ...but not explode into garbage combinations.
    expect(defaultStaticVocabulary.units.length).toBeLessThan(baseCount * 30);
  });

  it('accepts host-provided data for both layers (data in, no callbacks)', () => {
    const staticLayer: StaticVocabulary = { constants: ['g'], units: ['m', 's'], functions: ['f'] };
    const contextualLayer: ContextualVocabulary = { names: ['v_0', 'x_max'] };
    expect(staticLayer.constants).toEqual(['g']);
    expect(contextualLayer.names).toHaveLength(2);
  });
});

describe('default units match what the expression parser actually resolves', () => {
  it('every default unit evaluates like a mathjs unit', () => {
    // The derivation gate (isValuelessUnit) is not the same predicate as
    // "mathjs evaluates 5 <unit> to a Unit": chain/min/sec used to pass
    // validation and throw at evaluation. The list is now filtered by
    // parser resolution; this sweep pins zero broken entries.
    const broken: string[] = [];
    for (const unit of defaultStaticVocabulary.units) {
      try {
        const result = parse(`5 ${unit}`).evaluate();
        if (result === undefined || typeof result === 'function') broken.push(unit);
      } catch {
        broken.push(unit);
      }
    }
    expect(broken).toEqual([]);
  });

  it.each(['chain', 'min', 'sec'])('%s is reclassified: a function, not a unit', (name) => {
    // The expression parser resolves these as imports first, so a UnitNode
    // carrying them passed fromJSON, reported evaluable, and threw at
    // evaluation. They are gone from the unit list and rejected in the
    // unit channel.
    expect(defaultStaticVocabulary.units).not.toContain(name);
    expect(defaultStaticVocabulary.functions).toContain(name);
    expect(() =>
      fromJSON({ v: 1, root: { type: 'unit', value: { type: 'num', value: 5 }, unit: name } }),
    ).toThrow(/not a unit in the vocabulary/);
  });

  it('no unit string is also a default function name', () => {
    const units = new Set(defaultStaticVocabulary.units);
    const collisions = defaultStaticVocabulary.functions.filter((fn) => units.has(fn));
    expect(collisions).toEqual([]);
  });

  it('unit set contains no constants', () => {
    const units = new Set(defaultStaticVocabulary.units);
    const collisions = defaultStaticVocabulary.constants.filter((c) => units.has(c));
    expect(collisions).toEqual([]);
  });

  it('every default unit is identifier-shaped (format-guard parity)', () => {
    // The same shape the custom-vocabulary format guard enforces must hold
    // for every derived entry.
    for (const unit of defaultStaticVocabulary.units) {
      expect(isUnitSymbolShape(unit), unit).toBe(true);
    }
  });

  it('no mathjs-derivable prefix×unit candidate is missing (parser-shadowed ones excepted)', () => {
    // Exhaustive cross-check against the mathjs prefix tables: every
    // valueless-unit candidate is in the list, unless the expression parser
    // resolves it as a function/constant first (the deliberate filter).
    const math = create(all) as unknown as {
      Unit: { UNITS: Record<string, { prefixes?: Record<string, unknown> }>; isValuelessUnit: (s: string) => boolean };
    };
    const vocab = new Set(defaultStaticVocabulary.units);
    const prefixes = new Set<string>(['']);
    for (const def of Object.values(math.Unit.UNITS)) {
      if (def.prefixes) for (const p of Object.keys(def.prefixes)) prefixes.add(p);
    }
    const missing: string[] = [];
    for (const symbol of Object.keys(math.Unit.UNITS)) {
      for (const prefix of prefixes) {
        const candidate = prefix + symbol;
        if (!vocab.has(candidate) && math.Unit.isValuelessUnit(candidate) && !isParserShadowed(candidate)) {
          missing.push(candidate);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every parser-shadowed valueless-unit candidate is excluded from the list', () => {
    const math = create(all) as unknown as {
      Unit: { UNITS: Record<string, { prefixes?: Record<string, unknown> }>; isValuelessUnit: (s: string) => boolean };
    };
    const vocab = new Set(defaultStaticVocabulary.units);
    const prefixes = new Set<string>(['']);
    for (const def of Object.values(math.Unit.UNITS)) {
      if (def.prefixes) for (const p of Object.keys(def.prefixes)) prefixes.add(p);
    }
    for (const symbol of Object.keys(math.Unit.UNITS)) {
      for (const prefix of prefixes) {
        const candidate = prefix + symbol;
        if (isParserShadowed(candidate) && math.Unit.isValuelessUnit(candidate)) {
          expect(vocab.has(candidate), candidate).toBe(false);
        }
      }
    }
  });

  it('isParserShadowed agrees with actual parser resolution', () => {
    // The cheap derivation-time filter must not drift from the real
    // predicate (throws-or-not at evaluation).
    expect(isParserShadowed('min')).toBe(true);
    expect(isParserShadowed('sec')).toBe(true);
    expect(isParserShadowed('chain')).toBe(true);
    expect(isParserShadowed('mm')).toBe(false);
    expect(isParserShadowed('banana')).toBe(false);
    expect(() => parse('5 min').evaluate()).toThrow();
    expect(() => parse('5 mm').evaluate()).not.toThrow();
  });
});

describe('unit gate integrity (ported pins)', () => {
  it.each([
    ['a plain variable name', 'x'],
    ['a function name', 'sin'],
    ['a numeric literal', '5'],
    ['prototype key', '__proto__'],
    ['constructor key', 'constructor'],
  ])('fromJSON rejects %s in the unit channel', (_label, unit) => {
    expect(() =>
      fromJSON({ v: 1, root: { type: 'unit', value: { type: 'num', value: 5 }, unit } }),
    ).toThrow();
  });
});
