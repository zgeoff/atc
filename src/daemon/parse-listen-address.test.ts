import { expect, test } from 'bun:test';
import { parseListenAddress } from './parse-listen-address';

test.each([
  ['127.0.0.1:8415', '127.0.0.1', 8415],
  ['100.69.47.33:8415', '100.69.47.33', 8415],
  ['[::1]:1', '::1', 1],
  ['[fd7a:115c:a1e4::7]:65535', 'fd7a:115c:a1e4::7', 65_535],
])('it parses %p as a listen address', (raw, host, port) => {
  expect(parseListenAddress(raw)).toStrictEqual({ ok: true, host, port });
});

test.each([
  ['127.0.0.1'],
  ['127.0.0.1:'],
  ['127.0.0.1:0'],
  ['127.0.0.1:65536'],
  ['::1:8415'],
  [':8415'],
  ['[::1]'],
  ['127.0.0.1:84a'],
])('it refuses %p as a listen address shape', (raw) => {
  expect(parseListenAddress(raw)).toStrictEqual({
    ok: false,
    message: `--listen takes <host>:<port> with a port from 1 to 65535, not '${raw}'`,
  });
});

test.each([
  ['0.0.0.0:8415', '0.0.0.0'],
  ['[::]:8415', '::'],
  ['192.168.1.10:8415', '192.168.1.10'],
  ['localhost:8415', 'localhost'],
])('it refuses %p for a host outside the allowed ranges', (raw, host) => {
  expect(parseListenAddress(raw)).toStrictEqual({
    ok: false,
    message: `--listen refuses '${host}': bind a loopback address or one in 100.64.0.0/10 or fd7a:115c:a1e4::/48`,
  });
});
