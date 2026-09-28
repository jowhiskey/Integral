// Vocabulary interface (second versioned contract, alongside the JSON format).
// Symbol classification comes from host-provided data at use time: data in,
// decisions stay in Integral. Both layers are plain data — no host callbacks.

import { all, create } from 'mathjs';

/** Static vocabulary: constants, units, built-in functions. Passed once at editor init. */
export interface StaticVocabulary {
  constants: readonly string[];
  units: readonly string[];
  functions: readonly string[];
}

/** Contextual vocabulary: dynamic per-context names (per document, possibly per cursor position). */
export interface ContextualVocabulary {
  names: readonly string[];
}

// The standard mathjs constant set (all resolvable in the expression parser).
const MATHJS_CONSTANTS = ['pi', 'tau', 'e', 'phi', 'i', 'Infinity', 'NaN'] as const;

/** mathjs unit tables used for the default units list: base definitions + prefix-aware lookup. */
type MathUnit = {
  UNITS: Record<string, { prefixes?: Record<string, unknown> }>;
  isValuelessUnit: (name: string) => boolean;
};

const math = create(all) as unknown as Record<string, unknown> & { Unit: MathUnit };

/**
 * Default units list: every symbol mathjs itself accepts as a unit.
 *
 * mathjs stores prefixed units as prefix x base, not as standalone `UNITS` keys,
 * so `Object.keys(UNITS)` alone misses forms like `km`, `mm`, `kN`, `MPa`. This
 * derives prefix x base combinations from each unit's own prefix table and
 * keeps only candidates mathjs recognizes (`isValuelessUnit`), so the list
 * cannot drift from what mathjs actually parses. The base entries are kept
 * unchanged; prefixed forms extend the list.
 */
function deriveDefaultUnits(): string[] {
  const units = new Set<string>();
  for (const [symbol, definition] of Object.entries(math.Unit.UNITS)) {
    units.add(symbol);
    const prefixes = definition.prefixes;
    if (!prefixes) continue;
    for (const prefix of Object.keys(prefixes)) {
      if (prefix === '') continue; // identity prefix: the base entry itself
      const candidate = prefix + symbol;
      if (math.Unit.isValuelessUnit(candidate)) units.add(candidate);
    }
  }
  return [...units].sort();
}

/** Default static vocabulary — standard mathjs constant/unit set; hosts override once. */
export const defaultStaticVocabulary: StaticVocabulary = {
  constants: [...MATHJS_CONSTANTS],
  units: deriveDefaultUnits(),
  // Lowercase functions of the mathjs namespace (classes are uppercase).
  functions: Object.keys(math)
    .filter((key) => typeof math[key] === 'function' && /^[a-z]/.test(key))
    .sort(),
};
