// IME / dead-key event logger — the STANDING demo tool for every future
// IME, dead-key, and composition investigation (born in rework session
// 2b-2 from the Firefox/Windows open issue: the dead-^ composition never
// reached the editor's listeners on that platform, and three speculative
// resolution layers had been built without one real event record — the
// logger exists so that never happens again; instrumentation FIRST, fixes
// only from a read of the stream).
//
// Dev-only demo code — NOT part of the published package (package.json
// exports/files pin that; no src file may reference demo/). Every listener
// is capture-phase and passive: the logger observes the event stream
// BEFORE the editor's bubbling handlers see it, never preventDefaults, and
// never mutates editor state.

/** One recorded event stream line (a flat, human-readable record). */
export interface ImeLogLine {
  readonly seq: number;
  readonly surface: string;
  readonly line: string;
}

/** The raw-ish field dump of one keyboard event: every field the platform
 *  delivers, including the legacy ones — the whole point is to see what a
 *  specific browser/OS pair ACTUALLY emits. */
function keyFields(e: KeyboardEvent): string {
  const raw = e as KeyboardEvent & { location?: number; keyCode?: number; which?: number };
  return [
    `key=${JSON.stringify(e.key)}`,
    `code=${JSON.stringify(e.code)}`,
    `isComposing=${String(e.isComposing)}`,
    `location=${raw.location ?? '·'}`,
    `keyCode=${raw.keyCode ?? '·'}`,
    `which=${raw.which ?? '·'}`,
    `repeat=${String(e.repeat)}`,
    `flags=${e.altKey ? 'A' : ''}${e.ctrlKey ? 'C' : ''}${e.metaKey ? 'M' : ''}${e.shiftKey ? 'S' : ''}`,
  ].join(' ');
}

/** A defensive field reader: jsdom and older engines differ in which init
 *  dict members they carry on CompositionEvent. */
const dataOf = (e: Event): string => {
  const data = (e as { data?: unknown }).data;
  return data === undefined || data === null ? '' : String(data);
};

/**
 * Attach the logger: every keydown/keyup and
 * compositionstart/compositionupdate/compositionend event on `target` (the
 * editor's focus-bearing container), plus every click (test-logger session),
 * lands in `sink` as one pre-formatted line, capture-phase and passive.
 * Returns the detach function.
 */
export function attachImeLogger(
  target: HTMLElement,
  surface: string,
  sink: (line: ImeLogLine) => void,
): () => void {
  let seq = 0;
  const emit = (type: string, detail: string): void => {
    seq += 1;
    sink({ seq, surface, line: `${type}  ${detail}` });
  };
  const keyLine = (e: KeyboardEvent) => emit(e.type, keyFields(e));
  const compLine = (e: Event) => emit(e.type, `data=${JSON.stringify(dataOf(e))}`);
  /** Click capture (test-logger session): the mouse stream alongside the key
   *  stream — target described by id (uid) or tag, plus client coordinates. */
  const mouseLine = (e: Event) => {
    const me = e as MouseEvent;
    const t = me.target as Element | null;
    const target = t === null ? 'null' : t.id !== '' ? `#${t.id}` : `<${t.localName}>`;
    return emit(me.type, `button=${me.button} x=${me.clientX} y=${me.clientY} target=${target}`);
  };

  const listeners: Array<[keyof HTMLElementEventMap, EventListener]> = [
    ['keydown', keyLine as EventListener],
    ['keyup', keyLine as EventListener],
    ['compositionstart', compLine],
    ['compositionupdate', compLine],
    ['compositionend', compLine],
    ['click', mouseLine as EventListener],
    [
      'beforeinput',
      (e: Event) =>
        emit(
          e.type,
          `inputType=${JSON.stringify((e as { inputType?: unknown }).inputType ?? '·')} data=${JSON.stringify(dataOf(e))}`,
        ),
    ],
  ];
  for (const [type, listener] of listeners) {
    target.addEventListener(type, listener, { capture: true, passive: true });
  }
  return () => {
    for (const [type, listener] of listeners) {
      target.removeEventListener(type, listener, { capture: true });
    }
  };
}
