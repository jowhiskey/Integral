// Keyboard surface (DOM-layer session 2): the pinned keymap (printable
// single-character key → engine TypedToken) and key classification. The
// keydown handler lives on the editor root (focusable, tabindex="0") and acts
// only while the root is focused; handled keys are preventDefault'ed, every
// other key passes through untouched. No document-level listeners.

import type { NavDir, TypedToken } from '../engine/index.js';

/** The pinned keymap: printable single-character keys → typed tokens. Digits
 *  and letters are leaves; `+ - * / ^ ( )` are the structure tokens; `. ,`
 *  and Space route to the rework-session-2a mechanics (the decimal point, the
 *  comma arg append, the S-021 boundary). Any other printable key is outside
 *  the keymap — an unknown token, which the editor treats as a no-op. */
export const KEYMAP: Readonly<Record<string, TypedToken>> = (() => {
  const map: Record<string, TypedToken> = {};
  for (let d = 0; d <= 9; d++) {
    map[String(d)] = { t: 'leaf', node: { type: 'num', value: d } };
  }
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(97 + i)] = { t: 'leaf', node: { type: 'sym', name: String.fromCharCode(97 + i) } };
    map[String.fromCharCode(65 + i)] = { t: 'leaf', node: { type: 'sym', name: String.fromCharCode(65 + i) } };
  }
  map['+'] = { t: 'operator', fn: 'add' };
  map['-'] = { t: 'operator', fn: 'subtract' };
  map['*'] = { t: 'operator', fn: 'multiply' };
  map['/'] = { t: 'divide' };
  map['^'] = { t: 'pow' };
  map['('] = { t: 'groupOpen' };
  map[')'] = { t: 'groupClose' };
  map['.'] = { t: 'dot' };
  map[','] = { t: 'comma' };
  map[' '] = { t: 'space' };
  // A1 (2026-11-11): `=` is the assign structure token — eager insertion at
  // the root row (see policy.ts's assignKey).
  map['='] = { t: 'assign' };
  return map;
})();

/** What one keydown means for the editor. */
export type KeyAction =
  | { readonly kind: 'type'; readonly token: TypedToken | undefined }
  | { readonly kind: 'move'; readonly dir: NavDir }
  | { readonly kind: 'boundary'; readonly side: 'start' | 'end' }
  | { readonly kind: 'commit' }
  | { readonly kind: 'backspace'; readonly ctrl: boolean }
  | { readonly kind: 'delete'; readonly ctrl: boolean }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'deadPow' }
  | { readonly kind: 'ignore' };

/** U1 coalescing class (rework session 5 + OA-undo-burst, ruled 2026-11-10):
 *  the tokens that may extend an open typing run. The T7/T8 structure keys
 *  (`/`, `^`, the dead-key power) are NOT in this class — they close the run
 *  and form their own undo unit. OPERATORS are NOT in the class either
 *  (OA-undo-burst): every operator press is its OWN undo unit — consecutive
 *  operators never coalesce (`a++b` = two operator units); parens/comma/
 *  dot/space keep coalescing into the text run. Parens stay in the class: a
 *  `(` that merely creates a group or re-binds a head-less fence pair
 *  (OA-rehead, S-086) coalesces with the run; the T5 function conversion
 *  splits it — the engine forces that split at the conversion emission sites
 *  (S-085: the `(`-press + conversion is one unit of its own). The `=` assign
 *  token (A1, 2026-11-11) is NOT in the class either: insertion + split + grab
 *  is its own undo unit, like every structure key. */
export const isTypingToken = (token: TypedToken): boolean =>
  token.t === 'leaf' ||
  token.t === 'dot' ||
  token.t === 'space' ||
  token.t === 'comma' ||
  token.t === 'groupOpen' ||
  token.t === 'groupClose';

/** Classify one keydown event (structural type — no DOM dependency, so the
 *  classifier is unit-testable without jsdom):
 *  - Ctrl/Meta + Z            → undo;  Ctrl/Meta + Y or Ctrl/Meta + Shift + Z → redo
 *    (both `z` and `Z` with shift are handled); Ctrl/Meta + Backspace or
 *    Ctrl/Meta + Delete → the split-semantics variants (D3); any other
 *    modified key passes through — including Ctrl+Home/End, which stay
 *    UNBOUND (K1 rules out Ctrl variants).
 *  - Arrow keys               → move.
 *  - Home / End               → boundary (K1, rework session 5: local row/slot
 *                              boundary first, then iterative outward; S-105 A).
 *  - Enter / Tab / Escape     → commit (K2/K3, rework session 5: commit +
 *                              blur; the post-blur behavior is the host's).
 *  - Backspace                → backspace (D1–D9); Delete → forward delete
 *                              (the ruled D1/D3 mirrors + named no-op defaults).
 *  - a printable single character (key.length === 1, no Ctrl/Meta/Alt) → a
 *    typing key; `token` is undefined when the char is outside the pinned
 *    keymap (unknown token — still a handled key).
 *  - everything else (F-keys, PageUp/Down, …) → ignored, passed through. */
export function classifyKey(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly code?: string;
}): KeyAction {
  const key = event.key;
  if (event.ctrlKey || event.metaKey) {
    const k = key.toLowerCase();
    if (k === 'z' && !event.shiftKey) return { kind: 'undo' };
    if (k === 'y' || (k === 'z' && event.shiftKey)) return { kind: 'redo' };
    if (k === 'backspace') return { kind: 'backspace', ctrl: true }; // whole-node delete
    if (k === 'delete') return { kind: 'delete', ctrl: true }; // whole right-adjacent token
    return { kind: 'ignore' };
  }
  if (event.altKey) return { kind: 'ignore' };
  switch (key) {
    case 'Backspace':
      return { kind: 'backspace', ctrl: false };
    case 'Delete':
      return { kind: 'delete', ctrl: false };
    case 'ArrowLeft':
      return { kind: 'move', dir: 'left' };
    case 'ArrowRight':
      return { kind: 'move', dir: 'right' };
    case 'ArrowUp':
      return { kind: 'move', dir: 'up' };
    case 'ArrowDown':
      return { kind: 'move', dir: 'down' };
    case 'Home':
      return { kind: 'boundary', side: 'start' }; // K1 (session 5)
    case 'End':
      return { kind: 'boundary', side: 'end' }; // K1 (session 5)
    case 'Enter':
    case 'Tab':
    case 'Escape':
      return { kind: 'commit' }; // K2/K3 blur-commit (session 5)
    case 'Dead':
      // T8, as amended by the owner directive (2026-11-09, live check): ANY
      // dead-key press arms the pending power — layout-independent, no
      // event.code/shift identification. The positional ruling could not
      // survive real keyboards (the dead ^ sits unshifted on some layouts,
      // shifted or on other positions on others); a formula editor reads a
      // dead key as ^ entry, and the composition remnants are swallowed
      // (S-034/S-035).
      return { kind: 'deadPow' };
    default:
      break;
  }
  if (key.length === 1) return { kind: 'type', token: KEYMAP[key] };
  return { kind: 'ignore' };
}

/**
 * The keymap character a physical key code stands for, for keystrokes whose
 * `key` value carried no character identity — Firefox on Windows reports the
 * second keystroke of a dead-key composition as `'Process'` (the composed
 * character is unavailable, the code is not). Digits and letters only; null
 * when the code maps to nothing (the pending then falls back to the empty
 * power: the composed character is lost and retyped by hand).
 */
export function charFromCode(code: string | undefined): string | null {
  if (code === undefined) return null;
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return null;
}

/**
 * The character a completed dead-key composition stood for, for platforms whose
 * compositions never reach keydown (Firefox on Windows: the composed character
 * surfaces only in compositionend). Decomposed forms strip their combining
 * marks ('2' + U+0302 → '2'); a spacing-circumflex prefix ('^2', the
 * non-composable emission) yields what follows it; the bare circumflex ('^',
 * dead-^ + SPACE) is S-035 B's empty-exponent answer and returns ''. Null only
 * when the data carries no single-character reading at all.
 */
export function deadCompositionBase(data: string | undefined | null): string | null {
  if (data === undefined || data === null || data.length === 0) return null;
  const base = data.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
  const rest = base.startsWith('^') ? base.slice(1) : base;
  return rest.length === 1 ? rest : null;
}

/**
 * The composed base character of the two-character dead-key emission (the
 * owner's Firefox/Windows live reading, rework session 3): when a T8 pending is
 * armed and NO composition ever fires, the composed output rides the FOLLOW-UP
 * keydown as a two-character key value (`key === "^2"`, keyCode 50). The
 * character after the dead accent is the resolving character per S-034.
 * Null for anything else (F-keys like "F1"… start with an uppercase letter;
 * every other multi-char key value is not a composition this editor armed).
 */
export function deadComposedBase(key: string): string | null {
  if (key.length === 2 && !/^[A-Z]/.test(key)) return key[1];
  return null;
}
