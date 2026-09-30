// The web bundle's default Content-Security-Policy (deploy/web/csp.sh; plan 00048 P4.2-fix, audit
// C15): the script the web image's entrypoint sources, run here as the entrypoint runs it. Its
// stagenet origins must be exactly the ones core's STAGENET profile makes the page contact, and its
// fixed directives must stay strict. (The policy was also checked in a real browser against the
// built web image: deploy/web/csp-browser-check.sh.)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STAGENET } from '../src/network.js';

const script = fileURLToPath(new URL('../../../deploy/web/csp.sh', import.meta.url));
const deploy = (f: string) => readFileSync(fileURLToPath(new URL(`../../../deploy/${f}`, import.meta.url)), 'utf8');

function csp(...args: string[]): { ok: boolean; policy: string; directives: Map<string, string[]> } {
  const r = spawnSync('sh', [script, ...args], { encoding: 'utf8' });
  const policy = r.stdout.trim();
  const directives = new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0])
      .map((p) => [p[0]!, p.slice(1)] as const),
  );
  return { ok: r.status === 0, policy, directives };
}

describe('the default Content-Security-Policy of the web bundle (audit C15)', () => {
  it('stagenet: strict fixed directives, and exactly the origins core’s STAGENET profile contacts', () => {
    const { ok, directives, policy } = csp('stagenet', '/sponsor');
    expect(ok).toBe(true);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('style-src')).toEqual(["'self'"]);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:']);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(policy).not.toMatch(/unsafe-inline|'unsafe-eval'|\*/);
    const origin = (u: string) => new URL(u).origin;
    const m = STAGENET.midnight;
    const z = STAGENET.zswap;
    expect(new Set(directives.get('connect-src'))).toEqual(
      new Set([
        "'self'",
        origin(z.kernelUrl),
        origin(z.batcherUrl),
        origin(m.indexerUrl),
        origin(m.indexerWsUrl),
        origin(m.nodeUrl),
        origin(m.nodeWsUrl),
      ]),
    );
  });

  it('adds the sponsor’s origin when it is on another host, and extra origins; refuses a bad one', () => {
    const cross = csp('stagenet', 'https://sponsor.example.org/base/path');
    expect(cross.directives.get('connect-src')).toContain('https://sponsor.example.org');
    const extra = csp('stagenet', '/sponsor', 'https://kernel.example.org,wss://ws.example.org:8443');
    expect(extra.directives.get('connect-src')).toEqual(
      expect.arrayContaining(['https://kernel.example.org', 'wss://ws.example.org:8443']),
    );
    expect(csp('stagenet', '/sponsor', 'http://plain.example.org').ok).toBe(false);
    expect(csp('stagenet', '/sponsor', "https://x.org; script-src 'unsafe-inline'").ok).toBe(false);
    expect(csp('mainnet', '/sponsor').ok).toBe(false);
  });

  it('is on by default in the bundle: the image carries the script, the entrypoint sources it, empty means default', () => {
    expect(deploy('web.Dockerfile')).toMatch(/COPY deploy\/web\/csp\.sh \/usr\/local\/lib\/emt\/csp\.sh/);
    const entry = deploy('web/entrypoint.sh');
    expect(entry).toMatch(/^\. \/usr\/local\/lib\/emt\/csp\.sh$/m);
    expect(entry).toMatch(/''\)\s*\n\s*policy="\$\(emt_default_csp /);
    expect(deploy('compose.yml')).toMatch(/WEB_CONTENT_SECURITY_POLICY: \$\{WEB_CONTENT_SECURITY_POLICY:-\}/);
  });

  it('the native nginx site in deploy/SYSTEMD.md carries exactly the same policy', () => {
    const { policy } = csp('stagenet', '/sponsor');
    expect(deploy('SYSTEMD.md')).toContain(`add_header Content-Security-Policy "${policy}" always;`);
  });
});
