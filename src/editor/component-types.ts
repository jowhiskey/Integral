// Host-facing props of the IntegralEditor component — plain data/types only.

import type { Envelope } from '../ast/json.js';
import type { StaticVocabulary } from '../ast/vocabulary.js';
import type { Caret } from '../engine/caret.js';

export interface EditorProps {
  /** Initial formula envelope (validated through fromJSON); omitted = empty formula. */
  readonly envelope?: unknown;
  /** Static vocabulary the session validates against. */
  readonly vocabulary?: StaticVocabulary;
  /** Fired with the current envelope after every state change. */
  readonly onchange?: (envelope: Envelope) => void;
  /** Fired with the caret after pure caret placement (clicks). */
  readonly oncaret?: (caret: Caret) => void;
}
