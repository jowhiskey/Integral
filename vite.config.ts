// Root vite config — picked up by vitest (test pipeline). The demo page has its
// own config at demo/vite.config.ts (run `pnpm dev`).
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  resolve: {
    // svelte's client runtime resolves under the browser condition; vitest runs
    // with mode 'test', so enable it there only (vite dev/build use their own).
    conditions: mode === 'test' ? ['browser'] : [],
  },
  test: {
    environment: 'node',
    // editor tests opt into jsdom per file: // @vitest-environment jsdom
  },
}));
