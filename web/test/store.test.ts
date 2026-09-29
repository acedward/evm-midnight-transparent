// The browser store (adapted from MN Bank's store tests, acedward/passport-evm-dapp @ 911647b): keys
// per network and wallet, schema migrations, and Export / CLEAR ALL / Import as one all-or-nothing
// change that accepts only records this page writes. No record holds a secret.

import { beforeEach, describe, expect, it } from 'vitest';

import { exportFileText } from '../src/pages/LocalData.js';
import { storageText } from '../src/store/messages.js';
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_READ_BYTES,
  RECORD_KINDS,
  SCHEMA_KEY,
  STORE_PREFIX,
  StoreKeyError,
  parseKey,
  recordKey,
  type WalletScope,
} from '../src/store/schema.js';
import { ImportError, LocalStore, StoreFullError, StoreReadOnlyError, type Migration } from '../src/store/store.js';
import { expectImportRoundTrip } from './roundtrip.js';

const ME: WalletScope = { network: 'stagenet', evmAddress: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' };
const OTHER: WalletScope = { network: 'stagenet', evmAddress: `0x${'22'.repeat(20)}` };

const snapshot = () => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
};

const seed = (store: LocalStore) => {
  store.put(ME, 'profile', { firstSeen: 1, lastSeen: 2 });
  store.put(ME, 'settings', { units: 'whole' }, { id: 'display' });
  store.put(ME, 'settings', { minutes: 45 }, { id: 'expiry' });
  store.put(OTHER, 'profile', { firstSeen: 3 });
  store.put('global', 'settings', { theme: 'light' });
};

beforeEach(() => localStorage.clear());

describe('keys', () => {
  it('namespace by network and EVM address (lowercased), with an optional id', () => {
    const k = recordKey(ME, 'settings', { id: 'display' });
    expect(k).toBe(`evm-midnight-transparent/v1/stagenet/${ME.evmAddress.toLowerCase()}/settings/display`);
    expect(parseKey(k)).toEqual({
      scope: { global: false, network: 'stagenet', evmAddress: ME.evmAddress.toLowerCase() },
      kind: 'settings',
      id: 'display',
    });
    expect(parseKey(recordKey('global', 'settings'))).toEqual({ scope: { global: true }, kind: 'settings' });
    expect(recordKey(ME, 'profile')).toMatch(/\/profile$/);
  });

  it('refuse malformed parts, and parse nothing foreign', () => {
    expect(() => recordKey({ network: 'Stage Net', evmAddress: ME.evmAddress }, 'profile')).toThrow(StoreKeyError);
    expect(() => recordKey({ network: 'stagenet', evmAddress: '0x12' }, 'profile')).toThrow(StoreKeyError);
    expect(() => recordKey(ME, 'settings', { id: 'a/b' })).toThrow(StoreKeyError);
    for (const k of [
      'other/key',
      'evm-midnight-transparent/v1/stagenet/0x12/profile',
      `evm-midnight-transparent/v1/stagenet/${OTHER.evmAddress}/nope`,
      `evm-midnight-transparent/v1/_global/settings/a/b`,
      `mn-bank/v1/stagenet/${OTHER.evmAddress}/-/profile`,
    ]) {
      expect(parseKey(k)).toBeNull();
    }
  });

  it('has no secret record kind', () => {
    expect([...RECORD_KINDS]).toEqual(['profile', 'settings']);
  });
});

describe('the store', () => {
  it('writes nothing until the first record, then marks the schema version', () => {
    new LocalStore(localStorage);
    expect(localStorage.length).toBe(0);
    const store = new LocalStore(localStorage);
    store.put(ME, 'profile', { firstSeen: 1 });
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('1');
  });

  it('lists records per wallet, and reports sizes', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const mine = store.list(ME);
    expect(mine.map((v) => v.parsed.kind).sort()).toEqual(['profile', 'settings', 'settings']);
    expect(mine.every((v) => v.bytes > 0 && v.updatedAt !== null)).toBe(true);
    expect(store.list()).toHaveLength(5);
    expect(store.usage().keys).toBe(5);
  });

  it("notifies subscribers of its own writes and of other tabs' writes", () => {
    const store = new LocalStore(localStorage);
    let n = 0;
    const off = store.subscribe(() => n++);
    const detach = store.attach(window);
    store.put(ME, 'profile', {});
    window.dispatchEvent(new StorageEvent('storage', { key: recordKey(ME, 'profile') }));
    window.dispatchEvent(new StorageEvent('storage', { key: null })); // another tab cleared storage
    window.dispatchEvent(new StorageEvent('storage', { key: 'someone-else/key' }));
    expect(n).toBe(3);
    off();
    detach();
    store.put(ME, 'profile', {});
    expect(n).toBe(3);
  });

  it('says so when the browser refuses a write for lack of room', () => {
    const full = new FullStorage(localStorage, 10);
    const store = new LocalStore(full);
    expect(() => store.put(ME, 'profile', { firstSeen: 1 })).toThrow(StoreFullError);
    expect(storageText('full').title).toMatch(/no room left/);
    expect(storageText('blocked').text).toMatch(/private window/);
    expect(storageText('unavailable').title).toMatch(/no local storage/);
  });
});

describe('schema migrations', () => {
  const v2: Migration = {
    from: 1,
    to: 2,
    migrate: (entries) =>
      entries.map(([k, v]) => {
        const r = JSON.parse(v) as { kind: string; data: unknown };
        return r.kind === 'settings' ? [k, JSON.stringify({ ...r, data: { wrapped: r.data } })] : [k, v];
      }),
  };

  it('migrate stored data to the new version on open', () => {
    seed(new LocalStore(localStorage));
    const store = new LocalStore(localStorage, { version: 2, migrations: [v2] });
    expect(store.readOnly).toBe(false);
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('2');
    expect(store.get(recordKey(ME, 'settings', { id: 'display' }))?.data).toEqual({ wrapped: { units: 'whole' } });
    expect(store.get(recordKey(ME, 'profile'))?.data).toEqual({ firstSeen: 1, lastSeen: 2 });
  });

  it('are read-only when the data is newer than the page, or when no path exists', () => {
    seed(new LocalStore(localStorage));
    localStorage.setItem(SCHEMA_KEY, '3');
    const newer = new LocalStore(localStorage, { version: 2, migrations: [v2] });
    expect(newer.readOnly).toBe(true);
    expect(() => newer.put(ME, 'profile', {})).toThrow(StoreReadOnlyError);
    localStorage.setItem(SCHEMA_KEY, '1');
    expect(new LocalStore(localStorage, { version: 3, migrations: [v2] }).readOnly).toBe(true);
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('1'); // nothing was rewritten
  });

  it('migrate an older export on import', () => {
    const old = new LocalStore(localStorage);
    seed(old);
    const file = old.exportWallet(ME);
    localStorage.clear();
    const store = new LocalStore(localStorage, { version: 2, migrations: [v2], recordCheck: () => null });
    store.importWallet(file, ME);
    expect(store.get(recordKey(ME, 'settings', { id: 'expiry' }))?.data).toEqual({ wrapped: { minutes: 45 } });
  });
});

describe('Export, CLEAR ALL and Import', () => {
  it("round-trip one wallet's data exactly", () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const before = snapshot();
    const file = JSON.parse(JSON.stringify(store.exportWallet(ME))) as unknown; // as downloaded
    expect(file).toMatchObject({
      format: 'evm-midnight-transparent-local-data',
      formatVersion: 1,
      schemaVersion: 1,
      network: 'stagenet',
      evmAddress: ME.evmAddress.toLowerCase(),
    });
    expect((file as { records: unknown[] }).records).toHaveLength(3); // not OTHER's, not global

    expect(store.clearAll()).toBe(6); // 5 records + the schema marker
    expect(Object.keys(snapshot()).filter((k) => k.startsWith(STORE_PREFIX))).toEqual([]);

    const r = store.importWallet(file, {
      network: 'stagenet',
      evmAddress: ME.evmAddress.toUpperCase().replace('0X', '0x'),
    });
    expect(r).toEqual({ imported: 3, replaced: 0 });
    const after = snapshot();
    for (const [k, v] of Object.entries(before)) {
      if (k.includes(ME.evmAddress.toLowerCase())) expect(after[k]).toBe(v);
    }
    expect(store.importWallet(file, ME)).toEqual({ imported: 3, replaced: 3 });
    expectImportRoundTrip(store, ME);
  });

  it("CLEAR ALL leaves keys that are not this app's", () => {
    localStorage.setItem('another-app/key', 'x');
    const store = new LocalStore(localStorage);
    seed(store);
    store.clearAll();
    expect(snapshot()).toEqual({ 'another-app/key': 'x' });
  });

  it('refuse a file for another network or another wallet, and write nothing', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    store.clearAll();
    expect(() => store.importWallet(file, { network: 'undeployed', evmAddress: ME.evmAddress })).toThrow(
      /stagenet network/,
    );
    expect(() => store.importWallet(file, OTHER)).toThrow(/another wallet/);
    expect(localStorage.length).toBe(0);
  });

  it('refuse anything that is not an export, a foreign record, or a record this page would not write', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    store.clearAll();
    for (const bad of [null, 'text', {}, { ...file, format: 'mn-bank-local-data' }, { ...file, records: 'x' }]) {
      expect(() => store.importWallet(bad, ME), JSON.stringify(bad)?.slice(0, 40)).toThrow(ImportError);
    }
    const withRecord = (key: string, value: unknown) => ({ ...file, records: [...file.records, { key, value }] });
    const cases: Array<[unknown, RegExp]> = [
      [withRecord(recordKey(OTHER, 'profile'), { v: 1, kind: 'profile', updatedAt: 1, data: {} }), /does not belong/],
      [
        withRecord(recordKey('global', 'settings'), { v: 1, kind: 'settings', updatedAt: 1, data: {} }),
        /does not belong/,
      ],
      [
        withRecord(recordKey(ME, 'settings', { id: 'x' }), { v: 1, kind: 'profile', updatedAt: 1, data: {} }),
        /does not belong/,
      ],
      [
        withRecord(recordKey(ME, 'settings', { id: 'x' }), {
          v: 1,
          kind: 'settings',
          updatedAt: 1,
          data: { nested: { a: 1 } },
        }),
        /not in the shape/,
      ],
      [
        {
          ...file,
          records: file.records.map((r) =>
            parseKey(r.key)?.kind === 'profile'
              ? { ...r, value: { v: 1, kind: 'profile', updatedAt: 1, data: { firstSeen: 1, secret: 'x' } } }
              : r,
          ),
        },
        /not in the shape/,
      ],
      [{ ...file, schemaVersion: 99 }, /newer version/],
    ];
    for (const [bad, message] of cases) {
      expect(() => store.importWallet(bad, ME), JSON.stringify(bad).slice(-160)).toThrow(message);
    }
    expect(localStorage.length).toBe(0);
    expect(store.importWallet(file, ME)).toEqual({ imported: 3, replaced: 0 });
  });

  it('bounds the file: its size, and the same record twice', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    const big = {
      ...file,
      records: [
        ...file.records,
        ...Array.from({ length: 30 }, (_, i) => ({
          key: recordKey(ME, 'settings', { id: `pad-${i}` }),
          value: { v: 1, kind: 'settings', updatedAt: 1, data: { pad: 'x'.repeat(200_000) } },
        })),
      ],
    };
    expect(() => store.importWallet(big, ME)).toThrow(/more than a .* export can/);
    const twice = { ...file, records: [...file.records, file.records[0]!] };
    expect(() => store.importWallet(twice, ME)).toThrow(/same record twice/);
    expect(bytes(exportFileText(file))).toBeLessThanOrEqual(MAX_IMPORT_READ_BYTES);
    expect(MAX_IMPORT_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('Import is one change', () => {
  it('a storage failure part-way puts every key back and says nothing was imported', () => {
    const full = new FullStorage(localStorage, 1_000_000);
    const store = new LocalStore(full);
    seed(store);
    const before = snapshot();
    const file = store.exportWallet(ME);
    const changed = {
      ...file,
      records: [
        ...file.records.map((r) =>
          parseKey(r.key)?.id === 'display' ? { ...r, value: { ...(r.value as object), data: { units: 'base' } } } : r,
        ),
        {
          key: recordKey(ME, 'settings', { id: 'late' }),
          value: { v: 1, kind: 'settings', updatedAt: 5, data: { a: 'x'.repeat(250), b: 'x'.repeat(250) } },
        },
      ],
    };
    // Room for the changed record, not for the new one: the import fails part-way.
    full.capacity = full.used() + 100;
    expect(() => store.importWallet(changed, ME)).toThrow(
      /no room for the file, so nothing was imported \(everything is as it was\)/,
    );
    expect(snapshot()).toEqual(before);
    full.capacity = 1_000_000;
    expect(store.importWallet(changed, ME)).toEqual({ imported: 4, replaced: 3 });
  });

  it('says so, accurately, when a failed import cannot be fully undone', () => {
    const full = new FullStorage(localStorage, 1_000_000);
    const store = new LocalStore(full);
    seed(store);
    const file = store.exportWallet(ME);
    const changed = {
      ...file,
      records: [
        ...file.records,
        {
          key: recordKey(ME, 'settings', { id: 'late' }),
          value: { v: 1, kind: 'settings', updatedAt: 5, data: { a: 'x'.repeat(250), b: 'x'.repeat(250) } },
        },
      ],
    };
    full.capacity = full.used() + 100;
    full.removeItem = () => {
      throw new Error('storage broken');
    };
    expect(() => store.importWallet(changed, ME)).toThrow(
      /could not be fully undone: up to \d+ of 4 records may have changed/,
    );
  });
});

const bytes = (t: string) => new TextEncoder().encode(t).length;

/** localStorage with a size quota, like a browser's: a write that would take the total past
 *  `capacity` characters fails with the quota error and changes nothing. */
class FullStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    public capacity: number,
  ) {}
  used(): number {
    let n = 0;
    for (let i = 0; i < this.inner.length; i++) {
      const k = this.inner.key(i)!;
      n += k.length + this.inner.getItem(k)!.length;
    }
    return n;
  }
  get length() {
    return this.inner.length;
  }
  clear() {
    this.inner.clear();
  }
  getItem(k: string) {
    return this.inner.getItem(k);
  }
  key(i: number) {
    return this.inner.key(i);
  }
  removeItem(k: string) {
    this.inner.removeItem(k);
  }
  setItem(k: string, v: string) {
    const old = this.inner.getItem(k);
    const next = this.used() - (old === null ? 0 : k.length + old.length) + k.length + v.length;
    if (next > this.capacity) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.inner.setItem(k, v);
  }
}
