// The key a client is counted under for the per-client limits (plan 00048 P4.2-fix2, audit R4 /
// F-A21): an IPv4 address as it is, an IPv6 address by its /64 prefix. One subscriber usually holds
// a whole /64, so counting single IPv6 addresses would let one client rotate through 2^64 of them.
// An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as its IPv4 address. Anything that does
// not parse (e.g. "unknown") is counted as itself.

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(addr: string): number[] | null {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (!a.includes(':')) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const o = v4.slice(2, 6).map(Number);
    if (o.some((x) => x > 255)) return null;
    a = `${v4[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

/** The per-client key of an address (see the header). */
export function clientKeyOf(address: string): string {
  const g = ipv6Groups(address);
  if (g === null) return address.trim();
  // ::ffff:a.b.c.d → a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}
