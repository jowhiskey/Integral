import { describe, expect, it } from 'vitest';
import { evaluate } from 'mathjs';
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

  it('accepts host-provided data for both layers (data in, no callbacks)', () => {
    const staticLayer: StaticVocabulary = { constants: ['g'], units: ['m', 's'], functions: ['f'] };
    const contextualLayer: ContextualVocabulary = { names: ['v_0', 'x_max'] };
    expect(staticLayer.constants).toEqual(['g']);
    expect(contextualLayer.names).toHaveLength(2);
  });
});
