import { describe, expect, it } from 'vitest';
import * as ast from '../src/ast/index.js';
import * as editor from '../src/editor/index.js';

describe('subpath entry points', () => {
  it('ast and editor modules load', () => {
    expect(ast).toBeDefined();
    expect(editor).toBeDefined();
  });
});
