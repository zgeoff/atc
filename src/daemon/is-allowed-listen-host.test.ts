import { expect, test } from 'bun:test';
import { isAllowedListenHost } from './is-allowed-listen-host';

test.each([
  ['127.0.0.1'],
  ['127.255.0.9'],
  ['100.64.0.0'],
  ['100.69.47.33'],
  ['100.127.255.255'],
  ['::1'],
  ['0:0:0:0:0:0:0:1'],
  ['fd7a:115c:a1e4::1'],
  ['fd7a:115c:a1e4:ab12:cd34::5'],
])('it allows a listener on %p', (host) => {
  expect(isAllowedListenHost(host)).toBeTrue();
});

test.each([
  ['0.0.0.0'],
  ['::'],
  ['192.168.1.10'],
  ['10.42.0.1'],
  ['100.63.255.255'],
  ['100.128.0.0'],
  ['128.0.0.1'],
  ['::2'],
  ['fd7a:115c:a1e5::1'],
  ['fd7a:115c::1'],
  ['::ffff:127.0.0.1'],
  ['localhost'],
  ['example.com'],
  [''],
])('it refuses a listener on %p', (host) => {
  expect(isAllowedListenHost(host)).toBeFalse();
});
