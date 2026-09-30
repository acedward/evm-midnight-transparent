// The per-client key of the R4 caps (plan 00048 P4.2-fix2; audit R4, F-A21): an IPv6 client counts
// by its /64, so rotating addresses inside one subscriber's prefix does not multiply its allowance.

import { describe, expect, it } from 'vitest';

import { clientKeyOf } from '../src/client-key.js';

describe('R4: client keys', () => {
  it('IPv4 as is, IPv6 by /64, IPv4-mapped IPv6 as IPv4', () => {
    expect(clientKeyOf('198.51.100.7')).toBe('198.51.100.7');
    expect(clientKeyOf('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKeyOf('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2::/64');
    expect(clientKeyOf('[2001:DB8:1:2:ffff:0:0:9]')).toBe('2001:db8:1:2::/64');
    expect(clientKeyOf('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientKeyOf('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientKeyOf('::1')).toBe('0:0:0:0::/64');
    expect(clientKeyOf('unknown')).toBe('unknown');
    expect(clientKeyOf('2001:db8::1::2')).toBe('2001:db8::1::2'); // not an address: counted as itself
  });
});
