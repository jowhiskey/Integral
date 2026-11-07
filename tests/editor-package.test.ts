// Package integrity (node environment): the ./editor export resolves to the
// built entry point, ./ast and ./engine are unchanged, and the demo page is
// excluded from the published package (files/exports).

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, { types: string; import: string }>;
  files?: string[];
  scripts: Record<string, string>;
};

describe('package integrity', () => {
  it('./editor export resolves to the built entry point', () => {
    expect(pkg.exports['./editor']).toEqual({ types: './dist/editor/index.d.ts', import: './dist/editor/index.js' });
  });

  it('./ast and ./engine subpaths are unchanged', () => {
    expect(pkg.exports['./ast']).toEqual({ types: './dist/ast/index.d.ts', import: './dist/ast/index.js' });
    expect(pkg.exports['./engine']).toEqual({ types: './dist/engine/index.d.ts', import: './dist/engine/index.js' });
  });

  it('the demo is excluded from the published package', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
    expect(pkg.files!.some((f) => f.includes('demo'))).toBe(false);
    expect(Object.keys(pkg.exports).some((k) => k.includes('demo'))).toBe(false);
  });

  it('the editor sources exist and the build/dev scripts are wired', () => {
    expect(existsSync(new URL('../src/editor/index.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/editor/IntegralEditor.svelte', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/editor/controller.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../demo/index.html', import.meta.url))).toBe(true);
    expect(pkg.scripts.build).toContain('tsconfig.editor.json');
    expect(pkg.scripts.dev).toBe('vite demo');
  });
});
