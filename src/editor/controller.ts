// EditorController — the plain-TS DOM wiring behind the Svelte component (and
// directly usable by non-Svelte hosts). Owns the editing-engine state and the
// container's DOM:
//
//  - full rebuild per tree change: buildMathML produces a fresh <math> tree that
//    replaceChild's the old one (never surgical MathML mutation — Blink does not
//    reliably repaint after surgical MathML DOM changes);
//  - the caret is an overlay div (never inside the MathML), positioned from the
//    UID-mapped element rects;
//  - clicks map through the UID maps to structural carets — pure state, never an
//    undo-log entry (movement never logs).

import type { Envelope } from '../ast/json.js';
import type { MathNode } from '../ast/nodes.js';
import { toJSON } from '../ast/serialize.js';
import type { StaticVocabulary } from '../ast/vocabulary.js';

import {
  applyOp,
  caretResolvesIn,
  EngineError,
  envelopeOf,
  initSession,
  redo as engineRedo,
  typeToken,
  undo,
  type Caret,
  type EditingState,
  type NavDir,
  type Op,
  type TypedToken,
} from '../engine/index.js';

import { updateCaretOverlay } from './caret-overlay.js';
import { caretFromHit, hitFromMouseEvent } from './click.js';
import { classifyKey } from './keys.js';
import { buildMathML, type RenderedMath } from './mathml-dom.js';
import { applyVerticalKey, clearCurrentNode, type VerticalMemory } from './vertical-memory.js';

export interface EditorControllerOptions {
  /** Initial formula envelope (validated through fromJSON); omitted = empty formula. */
  readonly envelope?: unknown;
  /** Static vocabulary the session validates against (units gate). */
  readonly vocabulary?: StaticVocabulary;
  /** Fired after every state change (ops AND pure caret placement). */
  readonly onStateChange?: (state: EditingState) => void;
  /** Fired on caret placement (clicks); ops report through onStateChange. */
  readonly onCaretChange?: (caret: Caret) => void;
}

const CARET_CSS = `
.integral-caret {
  position: absolute;
  width: 2px;
  border-radius: 1px;
  background: currentColor;
  pointer-events: none;
  z-index: 100;
  animation: integral-caret-blink 1s infinite;
}
@keyframes integral-caret-blink {
  0% { opacity: 1; }
  50% { opacity: 0; }
  100% { opacity: 1; }
}
`;

const styledDocs = new WeakSet<Document>();

/** Inject the caret overlay stylesheet once per document (blink animation included,
 *  so the controller is self-contained without the Svelte component). */
export function ensureCaretStyles(doc: Document): void {
  if (styledDocs.has(doc)) return;
  styledDocs.add(doc);
  const style = doc.createElement('style');
  style.textContent = CARET_CSS;
  doc.head.appendChild(style);
}

export class EditorController {
  private state: EditingState;
  private readonly container: HTMLElement;
  private readonly caretDiv: HTMLElement;
  private rendered: RenderedMath | null = null;
  private mathEl: Element | null = null;
  private readonly onStateChange?: (state: EditingState) => void;
  private readonly onCaretChange?: (caret: Caret) => void;
  /** Vertical positional memory (never logged): keyed by AST nodes of the
   *  current envelope (`memEnv`), so it survives full rebuilds by
   *  construction; tree-changing actions clear it wholesale. */
  private vmem: VerticalMemory = new Map();
  private memRoot: MathNode | null = null;
  private memEnv: Envelope = { v: 1, root: null };

  constructor(container: HTMLElement, options: EditorControllerOptions = {}) {
    this.container = container;
    const doc = container.ownerDocument;
    ensureCaretStyles(doc);
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
    this.caretDiv = doc.createElement('div');
    this.caretDiv.className = 'integral-caret';
    container.appendChild(this.caretDiv);
    this.state = initSession(options.envelope, options.vocabulary);
    this.memRoot = this.state.root;
    this.memEnv = toJSON(this.state.root);
    this.onStateChange = options.onStateChange;
    this.onCaretChange = options.onCaretChange;
    container.addEventListener('click', this.handleClick);
    container.addEventListener('keydown', this.handleKeydown);
    this.render();
  }

  getState(): EditingState {
    return this.state;
  }

  /** The current tree envelope (what the host persists). */
  getEnvelope(): Envelope {
    return envelopeOf(this.state);
  }

  /** The latest rendered tree's UID maps (null before the first render). */
  getRendered(): RenderedMath | null {
    return this.rendered;
  }

  /** Apply an editing op (logs; undoable) and rebuild. */
  apply(op: Op): void {
    this.state = applyOp(this.state, op);
    this.syncMemory();
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Step the op log back one entry and rebuild. */
  undo(): void {
    const next = undo(this.state);
    if (next !== this.state) {
      this.state = next;
      this.syncMemory();
    }
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Step the redo list forward one entry and rebuild. */
  redo(): void {
    const next = engineRedo(this.state);
    if (next !== this.state) {
      this.state = next;
      this.syncMemory();
    }
    this.render();
    this.onStateChange?.(this.state);
  }

  /** The live vertical-memory map (read-only view; tests/hosts may inspect it). */
  getVerticalMemory(): ReadonlyMap<unknown, unknown> {
    return this.vmem;
  }

  /**
   * Pure caret placement (the click path): validated against the tree, applied as
   * state WITHOUT a log entry — movement never logs. Only the overlay is updated;
   * the MathML is not rebuilt for a caret-only change.
   */
  placeCaret(caret: Caret): void {
    const env = toJSON(this.state.root);
    if (!caretResolvesIn(env, caret)) {
      throw new EngineError('caret-invalid', `placeCaret: caret does not resolve in this tree (${JSON.stringify(caret)})`);
    }
    this.state = { root: this.state.root, caret, log: this.state.log, redo: this.state.redo, vocabulary: this.state.vocabulary };
    this.vmem.clear(); // click placement clears the whole vertical memory
    this.updateCaret();
    this.onCaretChange?.(caret);
    this.onStateChange?.(this.state);
  }

  /**
   * Full rebuild: a fresh <math> element replaces the old one via replaceChild
   * (no child-level reuse), then the caret overlay is re-anchored.
   */
  render(): void {
    const rendered = buildMathML(this.state.root, this.container.ownerDocument);
    if (this.mathEl !== null && this.mathEl.parentNode === this.container) {
      this.container.replaceChild(rendered.math, this.mathEl);
    } else {
      this.container.insertBefore(rendered.math, this.caretDiv);
    }
    this.mathEl = rendered.math;
    this.rendered = rendered;
    this.updateCaret();
  }

  /** Re-anchor the caret overlay against the current rendered tree (e.g. after a
   *  resize/scroll changed element rects). Does not rebuild the MathML. */
  updateCaret(): void {
    if (this.rendered !== null) {
      updateCaretOverlay(this.caretDiv, this.container, toJSON(this.state.root), this.state.caret, this.rendered);
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    if (this.rendered === null) return;
    const hit = hitFromMouseEvent(event, this.rendered);
    this.placeCaret(caretFromHit(toJSON(this.state.root), hit));
  };

  // ——— Keyboard (session 2): the handler lives on the focusable root and
  // acts only while the root is focused; handled keys are preventDefault'ed,
  // everything else passes through untouched. ———

  /** Tree-changing actions clear the whole memory; the map is keyed by nodes
   *  of the current envelope, so refresh that envelope whenever the root
   *  object changes (every mutating op rebuilds the root through fromJSON). */
  private syncMemory(): void {
    if (this.state.root !== this.memRoot) {
      this.memRoot = this.state.root;
      this.memEnv = toJSON(this.state.root);
      this.vmem.clear();
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.container.ownerDocument.activeElement !== this.container) return; // only while focused
    const action = classifyKey(event);
    switch (action.kind) {
      case 'ignore':
        return; // unhandled keys pass through untouched
      case 'undo':
        event.preventDefault();
        if (this.state.log.length > 0) this.undo();
        return;
      case 'redo':
        event.preventDefault();
        if (this.state.redo.length > 0) this.redo();
        return;
      case 'move':
        event.preventDefault();
        this.moveKey(action.dir);
        return;
      case 'type':
        // A typing key is handled (preventDefault) even when the token ends up
        // rejected or unknown — both are defined no-ops, never thrown.
        event.preventDefault();
        if (action.token !== undefined) this.typeKey(action.token);
        return;
    }
  };

  /** One arrow key: horizontal keys delete only the current node's memory
   *  entry; vertical keys go through the positional memory (jump-back wins
   *  over the structural move). Movement is never logged. */
  private moveKey(dir: NavDir): void {
    const env = this.memEnv;
    const caret = this.state.caret;
    if (dir === 'left' || dir === 'right') {
      this.vmem = clearCurrentNode(env, caret, this.vmem);
    } else {
      const res = applyVerticalKey(env, caret, dir, this.vmem);
      this.vmem = res.mem;
      if (res.fired) {
        // Jump-back: pure caret placement, never logged, no MathML rebuild.
        this.state = { root: this.state.root, caret: res.caret, log: this.state.log, redo: this.state.redo, vocabulary: this.state.vocabulary };
        this.updateCaret();
        this.onCaretChange?.(res.caret);
        this.onStateChange?.(this.state);
        return;
      }
    }
    const next = applyOp(this.state, { op: 'move', dir });
    if (next !== this.state) {
      this.state = next;
      this.updateCaret();
      this.onCaretChange?.(next.caret);
      this.onStateChange?.(this.state);
    }
  }

  /** One printable key → exactly one engine typeToken (insertion policy +
  *  swap hook). A rejected token (typed EngineError, e.g. not-a-typing-point
  *  at a row seam) is a defined no-op: no state change, no log growth, no
  *  exception escaping to the DOM. A successful type is a tree-changing
  *  action: it clears the vertical memory. */
  private typeKey(token: TypedToken): void {
    let next: EditingState;
    try {
      next = typeToken(this.state, token);
    } catch (e) {
      if (e instanceof EngineError) return;
      throw e;
    }
    if (next === this.state) return; // byte-identical no-op (same-op swap retype)
    this.state = next;
    this.syncMemory();
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Detach the listeners (the rendered DOM stays as-is). */
  destroy(): void {
    this.container.removeEventListener('click', this.handleClick);
    this.container.removeEventListener('keydown', this.handleKeydown);
  }
}
