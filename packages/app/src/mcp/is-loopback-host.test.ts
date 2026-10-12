import { expect, test } from 'bun:test';
import { isLoopbackHost } from './is-loopback-host';

test.each([['localhost'], ['127.0.0.1'], ['127.1.2.3'], ['::1'], ['[::1]']])(
  'it treats %p as loopback',
  (host) => {
    expect(isLoopbackHost(host)).toBeTrue();
  },
);

test.each([
  ['0.0.0.0'],
  ['::'],
  ['192.168.1.10'],
  ['100.64.0.1'],
  ['mcp.example.com'],
  ['127.0.0.1.example.com'],
])('it treats %p as reachable beyond this machine', (host) => {
  expect(isLoopbackHost(host)).toBeFalse();
});
