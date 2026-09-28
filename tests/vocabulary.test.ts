import { describe, expect, it } from 'vitest';
import { Unit, evaluate } from 'mathjs';
import { defaultStaticVocabulary, type ContextualVocabulary, type StaticVocabulary } from '../src/ast/index.js';

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
