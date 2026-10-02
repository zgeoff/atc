import { isIPv4, isIPv6 } from 'node:net';

/**
 * Whether an IP address is reachable on the public internet: not loopback,
 * private, link-local, carrier-grade NAT (which tailnets use), multicast, or
 * otherwise reserved. A client metadata fetch goes only to public addresses,
 * so a crafted client id cannot make atc probe the local network.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) {
    return isPublicIPv4(address);
  }

  if (isIPv6(address)) {
    return isPublicIPv6(address.toLowerCase());
  }

  return false;
}

function isPublicIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPublicIPv6(address: string): boolean {
  const mapped = /^::ffff:(?<v4>\d+\.\d+\.\d+\.\d+)$/.exec(address)?.groups?.['v4'];

  if (mapped !== undefined) {
    return isPublicIPv4(mapped);
  }

  return !(
    address === '::' ||
    address === '::1' ||
    /^f[cd]/.test(address) ||
    /^fe[89ab]/.test(address) ||
    address.startsWith('ff')
  );
}
