import { isIPv4, isIPv6 } from 'node:net';

/**
 * Whether an IP address is reachable on the public internet: not loopback,
 * private, link-local, carrier-grade NAT (which tailnets use), multicast,
 * documentation, benchmarking, or otherwise reserved. An IPv6 address that
 * embeds an IPv4 one (mapped, compatible, translated, NAT64, or 6to4) is
 * judged by the IPv4 address it carries, and the local-use NAT64 prefix
 * 64:ff9b:1::/48 is never public. A client metadata fetch goes only to
 * public addresses, so a crafted client id cannot make atc probe the local
 * network.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) {
    return isPublicIPv4(address.split('.').map(Number));
  }

  if (isIPv6(address)) {
    return isPublicIPv6(parseIPv6(address));
  }

  return false;
}

// The IANA special-purpose IPv4 blocks, plus multicast and the reserved
// 240/4, as [first octet, second octet, mask over the second octet].
const RESERVED_IPV4_BY_FIRST_TWO_OCTETS: readonly (readonly [number, number, number])[] = [
  [100, 64, 0xc0],
  [169, 254, 0xff],
  [172, 16, 0xf0],
  [192, 168, 0xff],
  [198, 18, 0xfe],
];

// Reserved /24 blocks, as their first three octets.
const RESERVED_IPV4_SLASH_24 = new Set([
  '192.0.0',
  '192.0.2',
  '192.88.99',
  '198.51.100',
  '203.0.113',
]);

function isPublicIPv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return false;
  }

  if (RESERVED_IPV4_SLASH_24.has(`${a}.${b}.${c}`)) {
    return false;
  }

  return !RESERVED_IPV4_BY_FIRST_TWO_OCTETS.some(
    ([first, second, mask]) => a === first && (b & mask) === second,
  );
}

// Expands a valid IPv6 address, with or without a zone, `::`, or a trailing
// dotted quad, into its 16 bytes.
function parseIPv6(address: string): readonly number[] {
  const [bare = ''] = address.toLowerCase().split('%');
  const [head = '', tail] = bare.split('::');
  const headGroups = parseIPv6Groups(head);
  const tailGroups = tail === undefined ? [] : parseIPv6Groups(tail);
  const zeros = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => 0);

  return [...headGroups, ...zeros, ...tailGroups].flatMap((group) => [group >> 8, group & 0xff]);
}

// Reads one side of `::` as 16-bit groups, a dotted quad counting as two.
function parseIPv6Groups(part: string): readonly number[] {
  if (part === '') {
    return [];
  }

  return part.split(':').flatMap((group) => {
    if (group.includes('.')) {
      const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);

      return [(a << 8) | b, (c << 8) | d];
    }

    return [Number.parseInt(group, 16)];
  });
}

function isPublicIPv6(bytes: readonly number[]): boolean {
  const embedded = findEmbeddedIPv4(bytes);

  if (embedded !== null) {
    return isPublicIPv4(embedded);
  }

  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0] = bytes;

  return !(
    (b0 & 0xfe) === 0xfc ||
    (b0 === 0xfe && (b1 & 0xc0) === 0x80) ||
    b0 === 0xff ||
    (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) ||
    (b0 === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) ||
    (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b && b4 === 0x00 && b5 === 0x01)
  );
}

// The IPv4 address an IPv6 address carries: the last four bytes under ::/96
// (which holds `::` and `::1`), ::ffff:0:0/96, ::ffff:0:0:0/96, and the NAT64
// prefix 64:ff9b::/96, and bytes 2 to 5 under the 6to4 prefix 2002::/16.
function findEmbeddedIPv4(bytes: readonly number[]): readonly number[] | null {
  const isZero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const last4 = bytes.slice(12, 16);

  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return bytes.slice(2, 6);
  }

  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;

  if (nat64) {
    return isZero(4, 12) ? last4 : null;
  }

  if (!isZero(0, 8)) {
    return null;
  }

  const compatible = isZero(8, 12);
  const mapped = isZero(8, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const translated = bytes[8] === 0xff && bytes[9] === 0xff && isZero(10, 12);

  return compatible || mapped || translated ? last4 : null;
}
