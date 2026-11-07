// @vitest-environment jsdom
// The ./editor subpath surface: every export resolves (including the Svelte
// component), and the component mounts — container with a rebuilt <math> plus
// the overlay caret div, and a click places the caret through oncaret.

import { describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

import * as editor from '../src/editor/index.js';
import type { Caret } from '../src/engine/index.js';

const sym = (name: string) => ({ type: 'sym', name }) as const;

describe('./editor entry point', () => {
  it('exports the builder, overlay, click mapping, controller, and the component', () => {
    expect(typeof editor.buildMathML).toBe('function');
    expect(typeof editor.caretAnchor).toBe('function');
    expect(typeof editor.updateCaretOverlay).toBe('function');
    expect(typeof editor.caretFromHit).toBe('function');
    expect(typeof editor.hitFromMouseEvent).toBe('function');
    expect(typeof editor.EditorController).toBe('function');
    expect(typeof editor.ensureCaretStyles).toBe('function');
    expect(editor.IntegralEditor).toBeDefined();
  });

  it('the Svelte component mounts: <math> rebuilt in the container + overlay caret div; click places the caret', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const oncaret = vi.fn<(caret: Caret) => void>();
    const app = mount(editor.IntegralEditor, {
      target,
      props: {
        envelope: { v: 1, root: { type: 'op', op: 'add', args: [sym('a'), sym('b')] } },
        oncaret,
      },
    });
    await new Promise((r) => setTimeout(r, 0)); // let onMount run

    const container = target.querySelector('.integral-editor') as HTMLDivElement;
    expect(container).not.toBeNull();
    const math = container.querySelector('math');
    expect(math).not.toBeNull();
    expect(math!.querySelectorAll('[id]').length).toBe(3); // op row + a + b
    const caretDiv = container.querySelector('.integral-caret');
    expect(caretDiv).not.toBeNull();

    // click the right half of b → row seam after b
    const b = [...math!.querySelectorAll('[id]')].find((e) => e.textContent === 'b')!;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 999 }));
    expect(oncaret).toHaveBeenCalledWith({ kind: 'row', path: [], index: 2 });

    await unmount(app);
  });
});
