// Typed validation errors and structural budgets for the fromJSON boundary.
//
// The JSON envelope is untrusted input: every rejection at the boundary is a
// typed ValidationError (still an Error for plain catch paths), and budget
// overruns are ValidationLimitError so hosts can distinguish "this payload is
// over a documented budget" from other malformed input. The budgets exist so
// the layer never emits a tree its own evaluation engine cannot evaluate:
// an n-ary op chain folds to a binary chain as deep as its arg count, and
// mathjs evaluate() recurses per fold level (measured: a left-folded add
// chain dies with a stack overflow between 1500 and 2000 levels on this
// runtime), so the node budget must stay well below that.

/** Structural budgets enforced by fromJSON. Exported so hosts can apply the
 *  same limits at their own input seams (text import, paste, API payloads). */
export const AST_LIMITS = {
  /** Maximum node depth (root = depth 1) of a deserialized tree. */
  maxDepth: 100,
  /** Maximum number of node objects in one envelope. */
  maxNodes: 500,
} as const;

/** Base class of every fromJSON rejection: a typed validation error. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A payload exceeded a structural budget (depth or node count). */
export class ValidationLimitError extends ValidationError {
  readonly kind: 'maxDepth' | 'maxNodes';
  readonly limit: number;

  constructor(kind: 'maxDepth' | 'maxNodes', limit: number, message: string) {
    super(message);
    this.name = 'ValidationLimitError';
    this.kind = kind;
    this.limit = limit;
  }
}
