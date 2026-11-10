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
import { toJSON } from '../ast/serialize.js';
import type { StaticVocabulary } from '../ast/vocabulary.js';

import {
  applyOp,
  caretResolvesIn,
  decideBackspace,
  EngineError,
  envelopeOf,
  forwardDelete,
  initSession,
  insertRoot as engineInsertRoot,
  insertSubscript as engineInsertSubscript,
  redo as engineRedo,
  settleUnits,
  typeToken,
  undo,
  unitSetOf,
  type BackspaceDecision,
  type Caret,
  type EditingState,
  type NavDir,
  type Op,
  type Path,
  type TypedToken,
} from '../engine/index.js';

import { updateCaretOverlay } from './caret-overlay.js';
import { caretFromHit, hitFromMouseEvent } from './click.js';
import { charFromCode, classifyKey, deadComposedBase, deadCompositionBase, KEYMAP } from './keys.js';
import { buildMathML, pathKey, type RenderedMath } from './mathml-dom.js';
import { applyVerticalKey, wipeSideways, type VerticalMemory } from './vertical-memory.js';

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
.integral-highlight {
  background: rgba(255, 0, 0, 0.25);
  border-radius: 2px;
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
  /** Vertical positional memory V2 (never logged): one stored caret per child
   *  region of every vertically aligned parent, keyed by (parent path, slot) —
   *  path-keyed, so it is immune to full rebuilds; nothing ever clears it
   *  (stores are caretResolvesIn-validated on read and discarded only when
   *  dangling). */
  private vmem: VerticalMemory = new Map();
  /** T8 dead-key pending (session 2b-1): controller-side and transient — a
   *  dead-key press (any layout — the owner directive 2026-11-09 overruled the
   *  positional event.code identification) gives no live feedback and the
   *  power materializes with the NEXT key press. Never a tree change, never
   *  serialized, never logged; one-shot (owner ruling 2026-11-09): it survives
   *  until the very next key press of any kind — a typing key resolves it,
   *  every other input (non-typing keys, clicks, blur) discards it and does
   *  its ordinary job untouched, EXCEPT the two-character composed emission
   *  (Firefox/Windows, rework session 3: `keydown key="^2"`, no composition
   *  events at all) which resolves it with the character after the dead
   *  accent. */
  private pendingDeadPow = false;
  /** D5 highlight-then-delete (rework session 3): the armed target structure
   *  path — a TRANSIENT controller/UI state derived from the engine's
   *  highlight decision kind, never serialized, NEVER an undo-log entry
   *  (U2). Any input that is not the confirming BS clears it and behaves as
   *  if it never had happened; the confirming BS deletes the structure WITH
   *  its content. Survives only caret movement (the visual-state roll). */
  private highlighted: Path | null = null;

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
    this.onStateChange = options.onStateChange;
    this.onCaretChange = options.onCaretChange;
    container.addEventListener('click', this.handleClick);
    container.addEventListener('keydown', this.handleKeydown);
    container.addEventListener('keyup', this.handleKeyup);
    container.addEventListener('compositionend', this.handleCompositionEnd);
    container.addEventListener('blur', this.handleBlur);
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
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Step the op log back one entry and rebuild. */
  undo(): void {
    this.takeHighlight(); // any input that is not the confirming BS clears it (D5)
    const next = undo(this.state);
    if (next !== this.state) this.state = next;
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Step the redo list forward one entry and rebuild. */
  redo(): void {
    this.takeHighlight(); // any input that is not the confirming BS clears it (D5)
    const next = engineRedo(this.state);
    if (next !== this.state) this.state = next;
    this.render();
    this.onStateChange?.(this.state);
  }

  /** The live vertical-memory map (read-only view; tests/hosts may inspect it). */
  getVerticalMemory(): ReadonlyMap<unknown, unknown> {
    return this.vmem;
  }

  // ——— S-051: the unit-run conversion fires on LEAVING the run ———

  /**
   * Settle every convertible unit run (S-051 C): the leave events are
   * controller-side — any non-letter key press, arrow (all movement keys),
   * any click (its target caret set first, so the mapping carries it), and
   * blur. One converted run = one logged op (undo restores the symbol run);
   * nothing convertible = no state change at all. Letters never fire it
   * (they extend the run), and neither do the undo/redo keys — history
   * commands are not content keys, and a settle landing with them would
   * clobber the redo list for a no-op keystroke.
   */
  private settle(triggerCaret?: Caret): boolean {
    const base: EditingState =
      triggerCaret === undefined ? this.state : { ...this.state, caret: triggerCaret };
    const next = settleUnits(base);
    if (next === base) return false;
    this.state = next;
    this.render();
    this.onStateChange?.(this.state);
    return true;
  }

  /** Whether the pressed key LEAVES a unit run (S-051's "any non-letter
   *  key"): every key except KEYMAP letters and the undo/redo history
   *  commands. */
  private readonly keyLeavesRun = (event: KeyboardEvent): boolean => {
    if (event.ctrlKey || event.metaKey) {
      const k = event.key.toLowerCase();
      return k !== 'z' && k !== 'y';
    }
    const token = KEYMAP[event.key];
    return !(event.key.length === 1 && token !== undefined && token.t === 'leaf' && token.node.type === 'sym');
  };

  private settleIfLeaving(event: KeyboardEvent): void {
    if (this.keyLeavesRun(event)) this.settle();
  }

  // ——— D5 highlight-then-delete (transient, never logged) ———

  /** The highlight element of an armed target path (null before the first render). */
  private highlightElement(path: Path): Element | null {
    const el = this.rendered?.elementByPath.get(pathKey(path));
    return el ?? null;
  }

  private paintHighlight(path: Path, on: boolean): void {
    const el = this.highlightElement(path);
    if (el === null) return;
    if (on) el.classList.add('integral-highlight');
    else el.classList.remove('integral-highlight');
  }

  /** Clear the armed highlight (paint off, state gone); returns the armed
   *  path for the one consumer that confirms (the BS key). */
  private takeHighlight(): Path | null {
    const armed = this.highlighted;
    if (armed !== null) this.paintHighlight(armed, false);
    this.highlighted = null;
    return armed;
  }

  /** One Backspace key (D1–D9; Ctrl = the D3 variants): at most one engine
   *  decision = at most one op = one log entry; the first-press D5 highlight
   *  arms the transient UI state (nothing applied, nothing logged — U2) and
   *  the confirming BS deletes the structure with its content. A defined
   *  no-op changes nothing; a rejected decision (typed EngineError) is a
   *  no-op, never thrown to the DOM. */
  private backspaceKey(ctrl: boolean, confirm: Path | null): void {
    let decision: BackspaceDecision;
    try {
      decision = decideBackspace(toJSON(this.state.root), this.state.caret, {
        ctrl,
        highlighted: confirm,
        units: unitSetOf(this.state),
      });
    } catch (e) {
      if (e instanceof EngineError) return;
      throw e;
    }
    if (decision.kind === 'highlight' && decision.target !== undefined) {
      this.highlighted = decision.target;
      this.paintHighlight(this.highlighted, true);
      return;
    }
    let next: EditingState = this.state;
    try {
      for (const op of decision.ops) next = applyOp(next, op);
    } catch (e) {
      if (e instanceof EngineError) return;
      throw e;
    }
    if (next === this.state) return; // defined no-op
    this.state = next;
    this.render();
    this.onStateChange?.(this.state);
  }

  /** One forward Delete key (the D1/D3 mirrors + the named no-op defaults):
   *  at most one op = one log entry; a defined no-op changes nothing. */
  private deleteKey(ctrl: boolean): void {
    let next: EditingState;
    try {
      next = forwardDelete(this.state, { ctrl });
    } catch (e) {
      if (e instanceof EngineError) return;
      throw e;
    }
    if (next === this.state) return; // defined no-op
    this.state = next;
    this.render();
    this.onStateChange?.(this.state);
  }
  /**
   * Pure caret placement (the click path): validated against the tree, applied as
   * state WITHOUT a log entry — movement never logs. Pending dead-^ (T8) does not
   * survive a caret placement — the click discards it and places the caret
   * (one-shot, owner ruling 2026-11-09). Only the overlay is updated;
   * the MathML is not rebuilt for a caret-only change.
   */
  placeCaret(caret: Caret): void {
    const env = toJSON(this.state.root);
    if (!caretResolvesIn(env, caret)) {
      throw new EngineError('caret-invalid', `placeCaret: caret does not resolve in this tree (${JSON.stringify(caret)})`);
    }
    this.pendingDeadPow = false;
    this.takeHighlight(); // a click is not the confirming BS (D5)
    this.state = { root: this.state.root, caret, log: this.state.log, redo: this.state.redo, vocabulary: this.state.vocabulary };
    // clicks write no memory entries (and V2 never clears anything)
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
    const caret = caretFromHit(toJSON(this.state.root), hit);
    this.pendingDeadPow = false; // the click discards the pending (T8, one-shot)
    if (this.settle(caret)) return; // S-051 click away: the mapped caret is placed
    this.placeCaret(caret);
  };

  // ——— Keyboard (sessions 2–3): the handler lives on the focusable root and
  // acts only while the root is focused; handled keys are preventDefault'ed,
  // everything else passes through untouched. ———

  /** Insertion vocabulary (T9): one insert = one op = one undo step; the
   *  caret lands per the ruled shapes (the radicand's beginning / the base
   *  label). EngineError rejections are defined no-ops. */
  insertRoot(opts: { readonly mroot?: boolean } = {}): void {
    this.applyEngineFn(() => engineInsertRoot(this.state, opts));
  }

  insertSubscript(): void {
    this.applyEngineFn(() => engineInsertSubscript(this.state));
  }

  /** Apply one engine-level editing function (vocabulary insertions): a
   *  rejected call is a defined no-op — no state change, no exception to the
   *  DOM (the typeKey pattern). */
  private applyEngineFn(fn: () => EditingState): void {
    let next: EditingState;
    try {
      next = fn();
    } catch (e) {
      if (e instanceof EngineError) return;
      throw e;
    }
    if (next === this.state) return;
    this.state = next;
    this.render();
    this.onStateChange?.(this.state);
  }

  private readonly handleBlur = (): void => {
    // T8 one-shot rule: blur discards a pending dead-^ with no trace.
    this.pendingDeadPow = false;
    this.takeHighlight(); // blur is not the confirming BS (D5)
    // S-051: blur leaves the run — the conversion lands before the host
    // takes the envelope (one op, logged, undoable while the session lives).
    this.settle();
  };

  /** Resolve a pending dead-^ with (at most) one typed character: the power
   *  materializes first (its own op — undo parity with a live layout's `^`
   *  followed by this key), then the character lands at the fresh exponent
   *  caret. Ch null/'' = the empty □ exponent (the character could not be
   *  recovered — retyped by hand); KEYMAP-unknown characters are swallowed
   *  (never re-dispatched). */
  private resolvePendingPow(ch: string | null): void {
    if (!this.pendingDeadPow) return;
    this.pendingDeadPow = false;
    this.typeKey({ t: 'pow' });
    const token = ch === null || ch === '' ? undefined : KEYMAP[ch];
    if (token !== undefined && token.t !== 'pow') this.typeKey(token);
  }

  private readonly handleCompositionEnd = (event: CompositionEvent): void => {
    // Firefox/Windows: the character completing a dead-key composition never
    // surfaces as a usable keydown (preventDefault does not cancel Firefox's
    // composition, and the composed keystroke bypasses keydown) — the composed
    // data in compositionend is the only character carrier left.
    if (!this.pendingDeadPow) return;
    this.resolvePendingPow(deadCompositionBase(event.data));
  };

  private readonly handleKeyup = (event: KeyboardEvent): void => {
    // Last-resort resolution: some platforms deliver the dead-composition's
    // character only on keyup. Guarded by the pending flag, so it can never
    // double-fire after a keydown/compositionend resolution.
    if (!this.pendingDeadPow) return;
    const ch = event.key === 'Process' ? charFromCode(event.code) : event.key.length === 1 ? event.key : null;
    if (ch === null) return;
    this.resolvePendingPow(ch);
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.container.ownerDocument.activeElement !== this.container) return; // only while focused
    this.settleIfLeaving(event); // S-051: leaving fires the conversion first
    // D5: any input that is not the confirming BS clears the armed highlight
    // (behaving as if it never happened) — the BS key consumes it as the
    // confirmation. A tree-changing settle invalidates the negotiation too
    // (the armed path comparison then simply mismatches — a fresh decision).
    const confirmHighlight = this.takeHighlight();
    if (this.pendingDeadPow && event.key === 'Process') {
      // Firefox on Windows may report the second keystroke of a dead-key
      // composition as 'Process' (no character identity in `key` — the
      // physical code carries it instead).
      event.preventDefault();
      this.resolvePendingPow(charFromCode(event.code));
      return;
    }
    const action = classifyKey(event);
    if (action.kind === 'deadPow') {
      // T8: no live feedback (S-034) — the OS composition is suppressed; the
      // power materializes with the NEXT key press. A re-press re-arms
      // (idempotent, nothing visible, nothing logged).
      event.preventDefault();
      this.pendingDeadPow = true;
      return;
    }
    if (this.pendingDeadPow) {
      this.pendingDeadPow = false;
      if (action.kind === 'type') {
        // The next typing key resolves the pending: the deferred `^` op runs
        // first (its own log entry — undo parity with a non-dead layout's `^`
        // followed by this key), then the key itself lands at the fresh
        // exponent caret — the character lands in the exponent (S-034), SPACE
        // resolves to the empty □ exponent (S-035 B). The OS-emitted literal
        // `^` is the swallow case: its whole job was the creation.
        event.preventDefault();
        this.typeKey({ t: 'pow' });
        if (action.token !== undefined && action.token.t !== 'pow') this.typeKey(action.token);
        return;
      }
      const composed = deadComposedBase(event.key);
      if (composed !== null) {
        // The Firefox/Windows rider (owner live reading 2026-11-09, rework
        // session 3): with the pending armed, NO composition ever fires and
        // the composed output rides the follow-up keydown as a two-character
        // key value (`key === "^2"`). Consume it: the character after the
        // dead accent resolves the pending power per S-034. (Inline like the
        // type-resolution branch above — resolvePendingPow would return
        // immediately: the pending flag is already consumed here.)
        event.preventDefault();
        this.typeKey({ t: 'pow' });
        const token = KEYMAP[composed];
        if (token !== undefined && token.t !== 'pow') this.typeKey(token);
        return;
      }
      // Any other key press discards the pending — the key then does its
      // ordinary job ("as if ^ had never been pressed"): fall through.
    }
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
      case 'backspace':
        event.preventDefault();
        this.backspaceKey(action.ctrl, confirmHighlight);
        return;
      case 'delete':
        event.preventDefault();
        this.deleteKey(action.ctrl);
        return;
      case 'type':
        // A typing key is handled (preventDefault) even when the token ends up
        // rejected or unknown — both are defined no-ops, never thrown.
        event.preventDefault();
        if (action.token !== undefined) this.typeKey(action.token);
        return;
    }
  };

  /** One arrow key (movement is never logged). Vertical keys go through the
   *  V2 positional memory: the leaving region stores the current caret, the
   *  arrival region's store wins when it still resolves; horizontal keys
   *  never touch the memory. */
  private moveKey(dir: NavDir): void {
    const caret = this.state.caret;
    if (dir === 'up' || dir === 'down') {
      const res = applyVerticalKey(toJSON(this.state.root), caret, dir, this.vmem);
      this.vmem = res.mem;
      if (res.caret === caret) return; // defined no-op: nothing written, nothing moved
      if (res.fired) {
        // Stored position won: pure caret placement, never logged, no MathML rebuild.
        this.state = { root: this.state.root, caret: res.caret, log: this.state.log, redo: this.state.redo, vocabulary: this.state.vocabulary };
        this.updateCaret();
        this.onCaretChange?.(res.caret);
        this.onStateChange?.(this.state);
        return;
      }
    }
    const next = applyOp(this.state, { op: 'move', dir });
    if (next !== this.state) {
      // OA-vmem-nesting (4b-1): a ←/→ press that EXITS a structure wipes
      // that structure's layer memory — the one clearing trigger; horizontal
      // movement never STORES anything (only vertical presses write).
      if (dir === 'left' || dir === 'right') {
        this.vmem = wipeSideways(toJSON(this.state.root), caret, next.caret, this.vmem);
      }
      this.state = next;
      this.updateCaret();
      this.onCaretChange?.(next.caret);
      this.onStateChange?.(this.state);
    }
  }

  /** One printable key → exactly one engine typeToken (insertion policy +
  *  swap hook + the in-token merge/split/snap rules). A rejected token (typed
  *  EngineError, e.g. not-a-typing-point at a row seam) is a defined no-op:
  *  no state change, no log growth, no exception escaping to the DOM. */
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
    this.render();
    this.onStateChange?.(this.state);
  }

  /** Detach the listeners (the rendered DOM stays as-is). */
  destroy(): void {
    this.container.removeEventListener('click', this.handleClick);
    this.container.removeEventListener('keydown', this.handleKeydown);
    this.container.removeEventListener('keyup', this.handleKeyup);
    this.container.removeEventListener('compositionend', this.handleCompositionEnd);
    this.container.removeEventListener('blur', this.handleBlur);
  }
}
