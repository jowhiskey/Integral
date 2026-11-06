// Precedence table (engine-owned, framework-free) — shared by the insertion
// policy (arc session 3) and the operator swap (arc session 4). Ordering and
// associativity are pinned against math.parse by the oracle: add/subtract <
// multiply/divide/mod < unaryMinus/unaryPlus < pow, and pow is the only
// right-associative operator. Contexts without a row (unknown op names,
// function rows, every fixed slot outside den/exp) are barriers — nothing
// binds out of them — and the token set is closed, so an absent row is always
// a reject, never a guess.

export interface PrecedenceRow {
  readonly prec: number;
  readonly assoc: 'left' | 'right';
  /** Unary form (if any) for operand-expected positions. */
  readonly unary?: 'unaryMinus' | 'unaryPlus';
}

export const PRECEDENCE: Readonly<Record<string, PrecedenceRow>> = {
  add: { prec: 1, assoc: 'left', unary: 'unaryPlus' },
  subtract: { prec: 1, assoc: 'left', unary: 'unaryMinus' },
  multiply: { prec: 2, assoc: 'left' },
  divide: { prec: 2, assoc: 'left' },
  mod: { prec: 2, assoc: 'left' },
  unaryMinus: { prec: 3, assoc: 'left' },
  unaryPlus: { prec: 3, assoc: 'left' },
  pow: { prec: 4, assoc: 'right' },
};

/** Flat n-ary row operators — the only fns that ever flatten into a shared
 *  op node (structural rule 3: pure chains only). Divide and pow are structure
 *  tokens (FractionNode / PowerNode), never flat rows. */
export const FLAT_FNS: ReadonlySet<string> = new Set(['add', 'subtract', 'multiply', 'mod']);

/** Operator fns the swap can re-bind (the operators a maximal visual row can
 *  contain): the flat rows plus the two structure operators. Unary rows have
 *  no operator positions (exactly one arg), unknown fns have no precedence —
 *  both keep the typed not-a-typing-point rejection. */
export const BINDER_FNS: ReadonlySet<string> = new Set(['add', 'subtract', 'multiply', 'mod', 'divide', 'pow']);
