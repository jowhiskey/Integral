<script lang="ts">
  // Demo surface for the DOM-layer arc: a fixed set of example formulas (legal
  // envelopes through fromJSON, including incomplete trees) so every caret
  // situation is reachable by clicking. Dev-only — not part of the published
  // package. Click a formula to focus it, then type / use arrow keys (vertical
  // memory included) / Backspace (peel, placeholders, structure death; Ctrl for
  // whole-node) / Ctrl+Z / Ctrl+Y.
  import { onMount } from 'svelte';
  import { EditorController, IntegralEditor } from '../src/editor/index.js';
  import type { Caret, Envelope, NodeJson } from '../src/engine/index.js';

  interface Example {
    readonly label: string;
    readonly envelope: unknown;
  }

  const num = (value: number) => ({ type: 'num', value }) as const;
  const sym = (name: string) => ({ type: 'sym', name }) as const;

  const EXAMPLES: Example[] = [
    { label: 'empty formula', envelope: { v: 1, root: null } },
    {
      label: '5 + □ (dangling add — empty row cell)',
      envelope: { v: 1, root: { type: 'op', op: 'add', args: [num(5), null] } },
    },
    {
      label: '(5+4×3)/2 — canonical fraction with group',
      envelope: {
        v: 1,
        root: {
          type: 'frac',
          num: {
            type: 'group',
            parens: 'always',
            child: { type: 'op', op: 'add', args: [num(5), { type: 'op', op: 'multiply', args: [num(4), num(3)] }] },
          },
          den: num(2),
        },
      },
    },
    {
      label: 'x² + 2x + 1 — pow node in an n-ary row',
      envelope: {
        v: 1,
        root: {
          type: 'op',
          op: 'add',
          args: [
            { type: 'pow', base: sym('x'), exp: num(2) },
            { type: 'op', op: 'multiply', args: [num(2), sym('x')] },
            num(1),
          ],
        },
      },
    },
    {
      label: '√16 + ³√x — square root and indexed root',
      envelope: {
        v: 1,
        root: {
          type: 'op',
          op: 'add',
          args: [
            { type: 'root', radicand: num(16) },
            { type: 'root', radicand: sym('x'), index: num(3) },
          ],
        },
      },
    },
    {
      label: '50 mm + 3 kg — units (upright, thin space)',
      envelope: {
        v: 1,
        root: {
          type: 'op',
          op: 'add',
          args: [
            { type: 'unit', value: num(50), unit: 'mm' },
            { type: 'unit', value: num(3), unit: 'kg' },
          ],
        },
      },
    },
    {
      label: 'sin(x, 0.5) — two-arg function row',
      envelope: { v: 1, root: { type: 'fn', name: 'sin', args: [sym('x'), num(0.5)] } },
    },
    { label: 'x_max — subscript', envelope: { v: 1, root: { type: 'sub', base: 'x', sub: 'max' } } },
    { label: '□/□ — empty fraction (both slots placeholders)', envelope: { v: 1, root: { type: 'frac', num: null, den: null } } },
    { label: '(□) — empty group', envelope: { v: 1, root: { type: 'group', parens: 'always', child: null } } },
    { label: '−□ — unary minus with empty operand', envelope: { v: 1, root: { type: 'op', op: 'unaryMinus', args: [null] } } },
    { label: 'empty symbol name', envelope: { v: 1, root: sym('') } },
    { label: '□ mm — unit with empty value', envelope: { v: 1, root: { type: 'unit', value: null, unit: 'mm' } } },
    {
      label: 'x+y over c+d — fraction rows for the vertical-memory demo (Down, Left, Left, Up)',
      envelope: {
        v: 1,
        root: {
          type: 'frac',
          num: { type: 'op', op: 'add', args: [sym('x'), sym('y')] },
          den: { type: 'op', op: 'add', args: [sym('c'), sym('d')] },
        },
      },
    },
    {
      label: '12/3 — backspace peel live check (Backspace peels digits → □ placeholders → structure death; Ctrl+Backspace deletes whole nodes)',
      envelope: { v: 1, root: { type: 'frac', num: num(12), den: num(3) } },
    },
    {
      label: '12+x over 3+y — vertical ping-pong with in-token carets (click into 12 or 3, Down/Up retraces the in-token index)',
      envelope: {
        v: 1,
        root: {
          type: 'frac',
          num: { type: 'op', op: 'add', args: [num(12), sym('x')] },
          den: { type: 'op', op: 'add', args: [num(3), sym('y')] },
        },
      },
    },
    {
      label: 'x + a/b — end seam live check (Right out of the b parks after the fraction; typing there appends/merges; a background click beyond the ink parks at start/end)',
      envelope: {
        v: 1,
        root: {
          type: 'op',
          op: 'add',
          args: [sym('x'), { type: 'frac', num: sym('a'), den: sym('b') }],
        },
      },
    },
    {
      label: 'x+5 — multi-digit typing + delete recovery (type digits at the end: 5→56; Backspace, then + and digit rebuild the row)',
      envelope: { v: 1, root: { type: 'op', op: 'add', args: [sym('x'), num(5)] } },
    },
    {
      label: 'deep nesting: ((2x)^□)/□ — incomplete pow + frac',
      envelope: {
        v: 1,
        root: {
          type: 'frac',
          num: { type: 'group', parens: 'always', child: { type: 'pow', base: { type: 'op', op: 'multiply', args: [num(2), sym('x')] }, exp: null } },
          den: null,
        },
      },
    },
  ];

  // per-example readouts, keyed by index
  let readouts: Record<number, { caret: string; env: string }> = $state({});

  const setReadout = (i: number, patch: { caret?: string; env?: string }): void => {
    readouts = { ...readouts, [i]: { caret: '—', env: '—', ...readouts[i], ...patch } };
  };
  const onCaret = (i: number) => (caret: Caret) => setReadout(i, { caret: JSON.stringify(caret) });
  const onChange = (i: number) => (env: Envelope) => setReadout(i, { env: JSON.stringify(env.root) });

  // rebuild-stress box: drives the controller directly to feel full-rebuild cost
  let stressContainer: HTMLDivElement | undefined = $state();
  let stress: EditorController | null = null;
  let stressInfo = $state('');
  onMount(() => {
    if (!stressContainer) return;
    stress = new EditorController(stressContainer, {
      envelope: { v: 1, root: { type: 'op', op: 'add', args: [sym('a')] } },
    });
  });
  const rootArgsLen = (): number => ((stress!.getEnvelope().root as { args: unknown[] }).args.length);
  const stressRun = (): void => {
    if (!stress) return;
    const n = 100;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const node: NodeJson = i % 2 === 0 ? num(i) : sym(`x${i}`);
      stress.apply({ op: 'insert', node, at: { at: 'row', path: [], index: rootArgsLen() } });
    }
    const ms = performance.now() - t0;
    stressInfo = `${n} tree changes → ${n} full <math> rebuilds in ${ms.toFixed(1)} ms (${(ms / n).toFixed(2)} ms per rebuild, formula now has ${rootArgsLen()} args)`;
  };
  const stressUndo = (): void => {
    if (!stress) return;
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) stress.undo();
    const ms = performance.now() - t0;
    stressInfo = `100 undos (each a full rebuild) in ${ms.toFixed(1)} ms`;
  };
</script>

<div class="example">
  <div class="label">rebuild stress — full-rebuild cost per tree change (dev check)</div>
  <div bind:this={stressContainer} class="integral-editor" tabindex="0" role="textbox" aria-label="stress"></div>
  <button onclick={stressRun}>apply 100 inserts (rebuild each)</button>
  <button onclick={stressUndo}>undo ×100</button>
  <div class="readout">{stressInfo}</div>
</div>

{#each EXAMPLES as ex, i}
  <div class="example">
    <div class="label">{ex.label}</div>
    <IntegralEditor envelope={ex.envelope} oncaret={onCaret(i)} onchange={onChange(i)} />
    <div class="readout">caret {readouts[i]?.caret ?? '—'}\nenv   {readouts[i]?.env ?? '—'}</div>
  </div>
{/each}
