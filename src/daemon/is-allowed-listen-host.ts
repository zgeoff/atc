import { isIPv4, isIPv6 } from 'node:net';

// An IPv6 range as its leading 16-bit groups and how many of their bits
// must match.
interface IPv6Range {
  readonly groups: readonly number[];
  readonly bits: number;
}

// The IPv6 ranges a listener may bind in: loopback `::1/128` and the
// tailnet range `fd7a:115c:a1e4::/48`.
const IPV6_RANGES: readonly IPv6Range[] = [
  { groups: [0, 0, 0, 0, 0, 0, 0, 1], bits: 128 },
  { groups: [0xfd_7a, 0x11_5c, 0xa1_e4], bits: 48 },
];

/**
 * Whether a TCP listener may bind the host: an IP literal that is loopback
 * (`127.0.0.0/8`, `::1`) or inside the tailnet ranges `100.64.0.0/10` and
 * `fd7a:115c:a1e4::/48`. The protocol carries no TLS, so a listener relies
 * on the tailnet's encryption, and a wildcard bind or a host name, whose
 * address could resolve anywhere, is refused.
 */
export function isAllowedListenHost(host: string): boolean {
  if (isIPv4(host)) {
    const octets = host.split('.').map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;

    return first === 127 || (first === 100 && second >= 64 && second <= 127);
  }

  if (isIPv6(host)) {
    const groups = expandIPv6Groups(host);

    return groups !== null && IPV6_RANGES.some((range) => hasPrefix(groups, range));
  }

  return false;
}

// The eight 16-bit groups of an IPv6 literal, or null for a literal with an
// embedded IPv4 tail, which no allowed range holds.
function expandIPv6Groups(host: string): number[] | null {
  if (host.includes('.')) {
    return null;
  }

  const [head = '', tail] = host.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = 8 - headGroups.length - tailGroups.length;

  return [...headGroups, ...Array.from({ length: fill }, () => '0'), ...tailGroups].map((group) =>
    Number.parseInt(group, 16),
  );
}

function hasPrefix(groups: readonly number[], range: IPv6Range): boolean {
  const whole = Math.floor(range.bits / 16);

  return range.groups.slice(0, whole).every((group, index) => groups[index] === group);
}
