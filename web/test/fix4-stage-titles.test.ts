// @vitest-environment node
// Plan 00048 P4.2-fix4, lane FW4: every stage id the sponsor can emit has a human title in both of the
// swap page's stage lists (bridge in, bridge out). The owner's live swap showed "6. evm-pending"
// untitled in both (evidence/00048-evm-midnight-transparent/owner-test/owner-swap-1.md).
//
// The ids are not an enum in the sponsor: they are string literals at the places that write a deposit
// or withdrawal record's stage. This test reads the sponsor's sources with the TypeScript parser and
// collects every id written by:
//   - `pushStage(record, id, …)` (sponsor/src/swaps/model.ts) and `this.stage(rec, record, id, …)`
//     (the service's helper);
//   - an object literal's `stage` property (a new deposit or withdrawal record, its `stages` entries;
//     the relay's progress events passed to `onProgress` are its own protocol and are mapped to stage
//     ids by `onRelayProgress`, whose `this.stage` calls are read);
//   - an assignment to `<something>.stage`.
// Each written id must be a string literal (or a conditional of them), a pass-through of a stage
// helper's own parameter, or a copy of a stored `.stage`: anything else fails here, so a new way of
// writing a stage id cannot slip past the titles. The mock sponsor's ids are read the same way.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { stageTitle } from '../src/swap/flow.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'vendor' && f !== 'node_modules') out.push(...sourceFiles(p));
    } else if (/\.ts$/.test(f) && !/\.d\.ts$/.test(f)) out.push(p);
  }
  return out;
}

/** The functions whose own parameter is a stage id being written (pass-throughs, not new ids). */
const STAGE_HELPERS = new Set(['pushStage', 'stage']);

interface Found {
  ids: Map<string, string[]>;
  problems: string[];
}

function enclosingHelperParams(node: ts.Node): Set<string> {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isArrowFunction(p)) {
      const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (name && STAGE_HELPERS.has(name))
        return new Set(p.parameters.map((x) => (ts.isIdentifier(x.name) ? x.name.text : '')).filter(Boolean));
      if (name) return new Set();
    }
  }
  return new Set();
}

function collect(files: readonly string[], opts: { mockSponsor?: boolean } = {}): Found {
  const ids = new Map<string, string[]>();
  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = (n: ts.Node) => `${relative(repo, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const add = (id: string, n: ts.Node): void => {
      ids.set(id, [...(ids.get(id) ?? []), where(n)]);
    };
    const value = (e: ts.Expression, at: ts.Node): void => {
      if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
        return value(e.expression, at);
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return add(e.text, at);
      if (ts.isConditionalExpression(e)) {
        value(e.whenTrue, at);
        value(e.whenFalse, at);
        return;
      }
      // A helper passing its own parameter on (pushStage inside `stage`, `rec.stage = stage`).
      if (ts.isIdentifier(e) && enclosingHelperParams(at).has(e.text)) return;
      // A copy of a stored stage (`stage: w.stage` in a view).
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'stage') return;
      // The mock's scripted stages (`this.stage(next)`, `DEPOSIT_STAGES[0]`) come from its SCRIPTS,
      // which this test reads whole.
      if (opts.mockSponsor) return;
      problems.push(`${where(at)}: a stage id this test cannot enumerate: \`${e.getText(sf)}\``);
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        const onThis = ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword;
        if (name === 'pushStage' && n.arguments[1]) value(n.arguments[1], n);
        // The service's `this.stage(rec, target, id, detail?)`; the mock's `this.stage(id)`.
        if (name === 'stage' && onThis) {
          const arg = opts.mockSponsor ? n.arguments[0] : n.arguments[2];
          if (arg) value(arg, n);
        }
      }
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        n.name.text === 'stage'
      ) {
        const literal = n.parent;
        const call = literal.parent;
        const relayEvent =
          ts.isCallExpression(call) &&
          (ts.isPropertyAccessExpression(call.expression) || ts.isIdentifier(call.expression)) &&
          (ts.isIdentifier(call.expression) ? call.expression.text : call.expression.name.text) === 'onProgress';
        if (!relayEvent) value(n.initializer, n);
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === 'stage'
      )
        value(n.right, n);
      // The mock's stage scripts: `const SCRIPTS = { deposit: [...], ... }`.
      if (
        opts.mockSponsor &&
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'SCRIPTS' &&
        n.initializer
      ) {
        const init = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (ts.isObjectLiteralExpression(init))
          for (const p of init.properties)
            if (ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer))
              for (const el of p.initializer.elements) value(el, el);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { ids, problems };
}

const sponsor = collect(sourceFiles(join(repo, 'sponsor', 'src')));
const mock = collect([join(repo, 'web', 'src', 'swap', 'mock', 'sponsor.ts')], { mockSponsor: true });

const untitled = (ids: Iterable<string>) =>
  [...ids].flatMap((id) =>
    (['deposit', 'withdraw'] as const)
      .filter((leg) => {
        const t = stageTitle(leg, id);
        return t === id || t.trim() === '' || t.length > 120;
      })
      .map((leg) => `${leg}: ${id}`),
  );

describe("P4.2-fix4: every stage id the sponsor can emit has a title in both of the page's stage lists", () => {
  it('reads the stage ids from the sponsor sources (and every way they are written is enumerable)', () => {
    expect(sponsor.problems).toEqual([]);
    // The ids the owner's swap showed, and a sample from every place that writes them: the reader
    // found them all (a moved or renamed file would make this test read nothing).
    for (const id of [
      'evm-pending',
      'waiting-for-funds',
      'queued',
      'mpc-signed',
      'evm-broadcast',
      'evm-final',
      'completed',
      'refunded',
      'submission-uncertain',
      'completed-foreign',
      'partial',
      'rearm-wait',
      'closed',
    ])
      expect([...sponsor.ids.keys()], id).toContain(id);
    expect(sponsor.ids.size).toBeGreaterThanOrEqual(25);
  });

  it('titles every one of them, in the bridge-in list and in the bridge-out list', () => {
    expect(untitled(sponsor.ids.keys())).toEqual([]);
  });

  it("titles the mock sponsor's ids too (the specs and the mock-mode demo show them)", () => {
    expect(mock.problems).toEqual([]);
    expect([...mock.ids.keys()]).toEqual(expect.arrayContaining(['evm-pending', 'settled', 'evm-failed', 'queued']));
    expect(untitled(mock.ids.keys())).toEqual([]);
  });

  it('gives evm-pending the human title the owner asked for, and keeps unknown ids as they came', () => {
    expect(stageTitle('deposit', 'evm-pending')).toBe('Waiting for the Sepolia transaction');
    expect(stageTitle('withdraw', 'evm-pending')).toBe('Waiting for the Sepolia transaction');
    // FS4's new id (plan Lane contracts, P4.2-fix4 lane FS4 item 4), titled ahead of its merge.
    expect(stageTitle('deposit', 'settled-elsewhere')).toBe('Deposit request found completed on Midnight');
    expect(stageTitle('withdraw', 'settled-elsewhere')).toBe('Withdrawal request found completed on Midnight');
    expect(stageTitle('deposit', 'something-new')).toBe('something-new');
    // Never a prototype member for an id that happens to be one.
    expect(stageTitle('withdraw', 'constructor')).toBe('constructor');
    expect(stageTitle('deposit', '__proto__')).toBe('__proto__');
  });
});
