import { expect, test } from 'bun:test';
import { isPublicAddress } from './is-public-address';

test.each([
  ['a public IPv4 address', '93.184.215.14'],
  ['a public IPv6 address', '2606:4700:10::6814:179a'],
  ['an IPv4-mapped public address', '::ffff:93.184.215.14'],
  ['an IPv4 address just past a private block', '172.32.0.1'],
])('it takes %s as public', (_label, address) => {
  expect(isPublicAddress(address)).toBeTrue();
});

test.each([
  ['the loopback address', '127.0.0.1'],
  ['a private 10/8 address', '10.20.30.40'],
  ['a private 172.16/12 address', '172.31.255.255'],
  ['a private 192.168/16 address', '192.168.1.1'],
  ['a shared carrier-grade NAT address', '100.64.0.1'],
  ['a link-local IPv4 address', '169.254.169.254'],
  ['the unspecified IPv4 address', '0.0.0.0'],
  ['a multicast IPv4 address', '224.0.0.1'],
  ['a documentation IPv4 address', '203.0.113.7'],
  ['the IPv6 loopback address', '::1'],
  ['the unspecified IPv6 address', '::'],
  ['a unique local IPv6 address', 'fd12:3456::1'],
  ['a link-local IPv6 address', 'fe80::1'],
  ['a link-local IPv6 address with a zone', 'fe80::1%eth0'],
  ['an IPv4-mapped private address', '::ffff:10.0.0.1'],
  ['an IPv4-mapped loopback address in hex', '::ffff:7f00:1'],
  ['a NAT64 address', '64:ff9b::a00:1'],
  ['a 6to4 address', '2002:a00:1::1'],
  ['a documentation IPv6 address', '2001:db8::1'],
  ['text that is not an address', 'example.com'],
])('it refuses %s as not public', (_label, address) => {
  expect(isPublicAddress(address)).toBeFalse();
});
