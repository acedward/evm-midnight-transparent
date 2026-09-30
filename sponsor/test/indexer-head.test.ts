// The live backend's read watermark (plan 00048 P4.2-fix3, audit S1): the vault's requests are read
// AS OF the indexer's latest block, whose height and timestamp come from one GraphQL query. A reply
// that is not a block never becomes a watermark (the read then fails, and nothing is concluded).

import { describe, expect, it } from 'vitest';

import { indexerHead } from '../src/bridge/live-backend.js';

const reply =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('S1: the indexer head', () => {
  it('reads the latest block’s height and timestamp (ms), with one query', async () => {
    const seen: { url: string; body: string }[] = [];
    const head = await indexerHead('https://indexer.example/api/v3/graphql', async (url, init) => {
      seen.push({ url, body: String(init.body) });
      return reply({ data: { block: { height: 650_563, timestamp: 1_790_544_294_000 } } })();
    });
    expect(head).toEqual({ height: 650_563, timeMs: 1_790_544_294_000 });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!.body).query).toContain('block { height timestamp }');
  });

  it('refuses anything that is not a block', async () => {
    await expect(indexerHead('u', reply({ data: { block: null } }))).rejects.toThrow(/block/);
    await expect(indexerHead('u', reply({ errors: [{ message: 'x' }] }))).rejects.toThrow(/block/);
    await expect(indexerHead('u', reply({ data: { block: { height: 1, timestamp: 'soon' } } }))).rejects.toThrow();
    await expect(indexerHead('u', reply({}, 503))).rejects.toThrow(/503/);
  });
});
