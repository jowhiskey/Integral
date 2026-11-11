// Versioned JSON contract (envelope v1). Short field names are machine-owned;
// the TS class API is the human-readable layer. Type-tag meanings never change
// without a version bump; later changes must be additive-only.

/**
 * Path into the tree for fence pairing (session 1, additive): steps from the
 * root to the paired open fence — a numeric step indexes an args row (op/fn),
 * a string step names a fixed-arity slot by its JSON field name (the same step
 * grammar the editing engine's caret paths use).
 */
export type FencePath = readonly (number | string)[];

export type NodeJson =
  // dot: the in-progress trailing decimal point (T4/S-012) — the number
  // renders `5.` and the in-token offsets address the dot (storable; additive,
  // emitted only when true so balanced states stay byte-unchanged). A dotted
  // number evaluates as its value (`5.` = 5) — the flag is visual/editing
  // state only, never evaluation semantics.
  | { type: 'num'; value: number; dot?: true }
  | { type: 'sym'; name: string }
  // implicit: render/storability marker of glyph-less juxtaposition (a multiply
  // row renders without × glyphs). Rendering/storability only — never written
  // by evaluation; emited only when true so balanced states stay byte-unchanged.
  | { type: 'op'; op: string; args: (NodeJson | null)[]; implicit?: boolean }
  | { type: 'fn'; name: string; args: (NodeJson | null)[]; close?: boolean }
  // close: the movable-paren state — false = the closing fence is absent (an
  // unbalanced state: storable + renders, refused by the structural gate).
  // close is emitted only when false so balanced states stay byte-unchanged.
  | { type: 'group'; parens: 'always'; child: NodeJson | null; close?: boolean }
  | { type: 'frac'; num: NodeJson | null; den: NodeJson | null }
  | { type: 'pow'; base: NodeJson | null; exp: NodeJson | null }
  // mroot: an nth root whose index SLOT exists — with index null it renders
  // mroot with a □ index slot (an empty 2D-slot state, T7). Without the flag,
  // index null stays the complete v1 square root. Additive, emitted only when
  // true so v1 byte output is unchanged.
  | { type: 'root'; radicand: NodeJson | null; index?: NodeJson | null; mroot?: boolean }
  | { type: 'sub'; base: string; sub: string }
  | { type: 'unit'; value: NodeJson | null; unit: string }
  // assign (added 2026-11-11, the `=` key feature — additive, envelope stays
  // v1): lhs/rhs each hold ANY single expression node or null (empty slot).
  // Shape-only validation — identifier validity is NOT checked here;
  // assignment-ness lives in isEvaluable (the root-only gate).
  | { type: 'assign'; lhs: NodeJson | null; rhs: NodeJson | null }
  // fence: a close-fence glyph token (the movable-paren model). open = path to
  // the paired open fence (a group/fn missing its own close); omitted/null =
  // a dangling close with nothing unclosed. Storable + renders, never a value.
  | { type: 'fence'; side: 'close'; open?: FencePath | null };

/** Envelope per formula: { "v": 1, "root": …node }. root null = entirely empty formula. */
export interface Envelope {
  v: 1;
  root: NodeJson | null;
}
