import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot });
  return out.toString().split('\0').filter(Boolean);
}

describe('line-ending policy (LF unification)', () => {
  it('all tracked text files contain zero CR bytes', () => {
    const offenders = trackedFiles().filter((f) =>
      readFileSync(join(repoRoot, f)).includes(0x0d),
    );
    expect(offenders).toEqual([]);
  });

  it('the root .gitattributes pins text=auto eol=lf', () => {
    expect(trackedFiles()).toContain('.gitattributes');
    expect(readFileSync(join(repoRoot, '.gitattributes'), 'utf8').trim())
      .toBe('* text=auto eol=lf');
  });
});
