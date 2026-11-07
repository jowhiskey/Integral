// Ambient module declaration so tsc can typecheck the ./editor entry point's import
// of the Svelte component (tsc does not read .svelte files; bundlers resolve them,
// and `pnpm build` copies the .svelte sources into dist/).
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<import('./component-types.js').EditorProps>;
  export default component;
}
