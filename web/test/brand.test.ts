// @vitest-environment node
// The app's display name lives in ONE constant (src/brand.ts; questions Q10): the pages import it and
// index.html takes it from the Vite config, so renaming the app is a one-line change.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_NAME } from '../src/brand.js';

describe('the app name', () => {
  it('lives in one constant: no other source file spells it', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|html|css)$/.test(f)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    files.push(join(root, 'index.html'));
    const spelled = files.filter((f) => !f.endsWith('brand.ts') && readFileSync(f, 'utf8').includes(APP_NAME));
    expect(spelled).toEqual([]);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('<title>%APP_NAME%</title>');
  });
});
