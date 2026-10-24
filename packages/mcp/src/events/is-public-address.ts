import { isIPv4, isIPv6 } from 'node:net';

// The IANA special-purpose registries' blocks that are not globally
// reachable, plus NAT64 and 6to4, which can carry a private IPv4 address.
const IPV4_BLOCKED: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

const IPV6_BLOCKED: readonly string[] = [
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/32',
  '2001:2::/48',
  '2001:10::/27',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
];

const IPV4_RANGES = IPV4_BLOCKED.map((cidr) => parseRange(cidr, 32));
const IPV6_RANGES = IPV6_BLOCKED.map((cidr) => parseRange(cidr, 128));

// An address with a zone, such as `fe80::1%eth0`, is link-local, so it is
// never public.
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) {
    return !isInRanges(parseIPv4(address), 32, IPV4_RANGES);
  }

  if (!isIPv6(address) || address.includes('%')) {
    return false;
  }

  const value = parseIPv6(address);

  // ::ffff:0:0/96 maps an IPv4 address, which then decides.
  if (value >> 32n === 0xff_ffn) {
    return !isInRanges(value & 0xff_ff_ff_ffn, 32, IPV4_RANGES);
  }

  return !isInRanges(value, 128, IPV6_RANGES);
}

interface Range {
  readonly base: bigint;
  readonly bits: number;
}

function isInRanges(value: bigint, width: number, ranges: readonly Range[]): boolean {
  return ranges.some((range) => {
    const shift = BigInt(width - range.bits);

    return value >> shift === range.base >> shift;
  });
}

function parseIPv4(address: string): bigint {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function parseRange(cidr: string, width: number): Range {
  const [address = '', bits = ''] = cidr.split('/');

  return { base: width === 32 ? parseIPv4(address) : parseIPv6(address), bits: Number(bits) };
}

function parseIPv6(address: string): bigint {
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);

  // An embedded IPv4 tail, as in `::ffff:10.0.0.1`, fills the last two groups.
  const expanded = tail.includes('.')
    ? `${address.slice(0, lastColon + 1)}${toHexGroups(tail)}`
    : address;

  const [head = '', rest] = expanded.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - headGroups.length - restGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...restGroups];

  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function toHexGroups(ipv4: string): string {
  const value = parseIPv4(ipv4);

  return `${(value >> 16n).toString(16)}:${(value & 0xff_ffn).toString(16)}`;
}
