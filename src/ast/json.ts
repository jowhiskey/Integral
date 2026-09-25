// Versioned JSON contract (envelope v1). Short field names are machine-owned;
// the TS class API is the human-readable layer. Type-tag meanings never change
// without a version bump; later changes must be additive-only.

export type NodeJson =
  | { type: 'num'; value: number }
  | { type: 'sym'; name: string }
  | { type: 'op'; op: string; args: (NodeJson | null)[] }
  | { type: 'fn'; name: string; args: (NodeJson | null)[] }
  | { type: 'group'; parens: 'always'; child: NodeJson | null }
  | { type: 'frac'; num: NodeJson | null; den: NodeJson | null }
  | { type: 'pow'; base: NodeJson | null; exp: NodeJson | null }
  | { type: 'root'; radicand: NodeJson | null; index?: NodeJson | null }
  | { type: 'sub'; base: string; sub: string }
  | { type: 'unit'; value: NodeJson | null; unit: string };

/** Envelope per formula: { "v": 1, "root": …node }. root null = entirely empty formula. */
export interface Envelope {
  v: 1;
  root: NodeJson | null;
}
