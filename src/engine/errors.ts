// Typed engine errors. Every structural rejection of an op is one of these
// (bad position, occupied/empty target, out-of-range index, invalid caret);
// rejections that come from the AST contract itself (invalid inserted node,
// arity/budget violations) propagate from fromJSON as ValidationError /
// ValidationLimitError instead — the engine surface keeps the two origins
// distinguishable for hosts.

export type EngineErrorCode =
  | 'unknown-op'
  | 'unknown-position'
  | 'slot-occupied'
  | 'slot-empty'
  | 'index-out-of-range'
  | 'caret-invalid';

/** An op could not be applied to the state it was given. The state is
 *  unchanged and nothing was logged. */
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
