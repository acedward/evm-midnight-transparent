// Two rules of this repository, checked over every source file (plan P0 testing):
//   1. nothing depends on the Passport account contract: the word appears only in provenance notes
//      (comments) and in the vault records' own repository name;
//   2. no token is special (owner rule): no quote currency, no stock role, no pair rules.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_DIRS = ['packages', 'sponsor', 'web', 'scripts'];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'fixtures', 'deployments', 'vendor'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield p;
  }
}

const files = SOURCE_DIRS.flatMap((d) => [...sources(join(ROOT, d))]);
const lines = files.flatMap((f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .map((text, i) => ({ where: `${relative(ROOT, f)}:${i + 1}`, text })),
);
const isComment = (t: string) => /^\s*(\/\/|\/\*|\*)/.test(t);

describe('the seed rules', () => {
  it('reads the sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('mentions Passport only in provenance notes', () => {
    const THIS_FILE = relative(ROOT, fileURLToPath(import.meta.url));
    const offending = lines.filter(
      (l) =>
        /passport/i.test(l.text) &&
        !isComment(l.text) &&
        !l.where.startsWith(`${THIS_FILE}:`) &&
        l.text.trim() !== "repo: 'acedward/passport'," &&
        !/it\('are byte-identical to acedward\/passport @ 6c7505a/.test(l.text),
    );
    expect(offending.map((l) => `${l.where}: ${l.text.trim()}`)).toEqual([]);
  });

  it('has no special token: no usdc or stock roles, no quote currency, no pair rules', () => {
    const THIS_FILE = relative(ROOT, fileURLToPath(import.meta.url));
    const rule =
      /\busdc\(\)|\bstocks\(\)|isTradablePair|TOKEN_ROLES|role:\s*'(usdc|stock)'|role\s*===\s*'(usdc|stock)'/;
    const offending = lines.filter(
      (l) =>
        rule.test(l.text) &&
        !l.where.startsWith(`${THIS_FILE}:`) &&
        !l.where.startsWith('packages/core/test/tokens.test.ts:'),
    );
    expect(offending.map((l) => `${l.where}: ${l.text.trim()}`)).toEqual([]);
  });
});
