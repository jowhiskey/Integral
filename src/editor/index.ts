// Editor entry point (browser-only): the Svelte 5 component wrapping the editor,
// the plain-TS MathML DOM builder (per-node UIDs), the caret overlay, click→caret
// placement, and the DOM-wiring controller. The AST core and the editing engine
// stay framework-free — this subpath is the only one that touches the DOM.

export * from './mathml-dom.js';
export * from './caret-overlay.js';
export * from './click.js';
export * from './component-types.js';
export * from './controller.js';

export { default as IntegralEditor } from './IntegralEditor.svelte';
