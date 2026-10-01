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

/** Unit symbols live in the frozen SymbolNode projection: a unit string must be
 *  a single identifier token (letters/digits only, no operator, space, slash,
 *  or underscore characters) or the projected tree cannot survive display
 *  round-trips. Every entry of the derived default list satisfies this shape. */
const UNIT_SYMBOL_PATTERN = /^[\p{L}\p{N}]+$/u;

/** True iff `name` is identifier-shaped so it can act as a unit symbol. */
export function isUnitSymbolShape(name: string): boolean {
  return UNIT_SYMBOL_PATTERN.test(name);
}

/** True iff the expression parser resolves `name` as a known function or
 *  constant before it could ever resolve it as a unit symbol (mathjs resolves
 *  imported names first, so `5 min` multiplies by the function `min` and
 *  throws, never reaching the unit `min`). Such strings cannot be units. */
export function isParserShadowed(name: string): boolean {
  return math[name] !== undefined;
}

/**
 * Default units list: every symbol mathjs itself accepts as a unit.
 *
 * mathjs stores prefixed units as prefix x base, not as standalone `UNITS` keys,
 * so `Object.keys(UNITS)` alone misses forms like `km`, `mm`, `kN`, `MPa`. This
 * derives prefix x base combinations from each unit's own prefix table and
 * keeps only candidates mathjs recognizes (`isValuelessUnit`), so the list
 * cannot drift from what mathjs actually parses. The base entries are kept
 * unchanged; prefixed forms extend the list. Candidates the expression parser
 * resolves as functions or constants first (e.g. `chain`, `min`, `sec`) are
 * dropped: `isValuelessUnit` only checks the unit tables, while the parser
 * resolves those names as imports first, so a UnitNode carrying them would
 * pass validation and throw at evaluation.
 */
function deriveDefaultUnits(): string[] {
  const units = new Set<string>();
  for (const [symbol, definition] of Object.entries(math.Unit.UNITS)) {
    if (!isParserShadowed(symbol)) units.add(symbol);
    const prefixes = definition.prefixes;
    if (!prefixes) continue;
    for (const prefix of Object.keys(prefixes)) {
      if (prefix === '') continue; // identity prefix: the base entry itself
      const candidate = prefix + symbol;
      if (!isParserShadowed(candidate) && math.Unit.isValuelessUnit(candidate)) {
        units.add(candidate);
      }
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
