import { expect, test } from 'bun:test';
import { parseGatewayStateDir } from './parse-gateway-state-dir';

test.each([
  { argv: ['--state-dir', '/a', 'clients', 'add', 'C'], env: {}, expected: '/a' },
  { argv: ['--state-dir=/a', 'clients', 'add', 'C'], env: {}, expected: '/a' },
  { argv: ['clients', '--state-dir', '/a', 'add', 'C'], env: {}, expected: '/a' },
  { argv: ['clients', 'add', 'C', '--state-dir=/a'], env: {}, expected: '/a' },
  { argv: ['serve', '--state-dir', '/a'], env: { ATC_GATEWAY_STATE_DIR: '/env' }, expected: '/a' },
  { argv: ['--state-dir=/a', 'serve', '--state-dir', '/a'], env: {}, expected: '/a' },
  { argv: ['serve', '--port', '8414'], env: { ATC_GATEWAY_STATE_DIR: '/env' }, expected: '/env' },
  { argv: ['serve'], env: { ATC_GATEWAY_STATE_DIR: '' }, expected: null },
  { argv: ['serve', '--help'], env: {}, expected: null },
  { argv: ['--state-dir=-x', 'serve'], env: {}, expected: '-x' },
  {
    argv: ['clients', 'add', '--', '--state-dir', '/a'],
    env: { ATC_GATEWAY_STATE_DIR: '/env' },
    expected: '/env',
  },
  {
    argv: ['clients', 'add', 'C', '--redirect-uri', 'https://example.com/--state-dir'],
    env: {},
    expected: null,
  },
])('it reads the state directory $expected from $argv with the environment $env', (row) => {
  expect(
    parseGatewayStateDir(row.argv, row.env, {
      values: new Set(['port', 'redirect-uri', 'state-dir']),
      switches: new Set(['help']),
    }),
  ).toStrictEqual({ ok: true, stateDir: row.expected });
});

test.each([
  {
    argv: ['--state-dir=/a', 'clients', 'add', '--state-dir', '/b'],
    message: "--state-dir gives different directories: '/a', '/b'",
  },
  {
    argv: ['clients', 'add', 'C', '--redirect-uri', '--state-dir', '/a'],
    message: '--redirect-uri needs a value; write --redirect-uri=<value>',
  },
  {
    argv: ['serve', '--state-dir'],
    message: '--state-dir needs a value; write --state-dir=<value>',
  },
  {
    argv: ['serve', '--state-dir='],
    message: '--state-dir needs a value; write --state-dir=<value>',
  },
  { argv: ['--stat-dir=/a', 'serve'], message: "unknown flag '--stat-dir=/a'" },
  { argv: ['serve', '-s', '/a'], message: "unknown flag '-s'" },
  { argv: ['serve', '--help=yes'], message: '--help=yes takes no value' },
])('it refuses $argv', (row) => {
  expect(
    parseGatewayStateDir(
      row.argv,
      { ATC_GATEWAY_STATE_DIR: '/env' },
      {
        values: new Set(['port', 'redirect-uri', 'state-dir']),
        switches: new Set(['help']),
      },
    ),
  ).toStrictEqual({ ok: false, message: row.message });
});
