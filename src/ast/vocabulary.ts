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

const math = create(all) as unknown as Record<string, unknown> & { Unit: { UNITS: Record<string, unknown> } };

/** Default static vocabulary — standard mathjs constant/unit set; hosts override once. */
export const defaultStaticVocabulary: StaticVocabulary = {
  constants: [...MATHJS_CONSTANTS],
  units: Object.keys(math.Unit.UNITS).sort(),
  // Lowercase functions of the mathjs namespace (classes are uppercase).
  functions: Object.keys(math)
    .filter((key) => typeof math[key] === 'function' && /^[a-z]/.test(key))
    .sort(),
};
