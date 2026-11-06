// Editing engine entry point: ops as values, the reducer, undo, and the
// caret type — runtime-agnostic (no DOM, no framework), like the AST subpath.
// The editor/DOM layer and navigation profiles build on top of this.
export * from './caret.js';
export * from './errors.js';
export * from './ops.js';
