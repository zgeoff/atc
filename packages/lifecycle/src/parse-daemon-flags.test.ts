import { expect, test } from 'bun:test';
import { parseDaemonFlags } from './parse-daemon-flags';

test('it reads both listener flags from a command line', () => {
  const args = [
    'bun',
    '/src/cli.ts',
    'daemon',
    '--listen',
    '127.0.0.1:8500',
    '--token-file',
    '/t/tokens',
  ];

  expect(parseDaemonFlags(args)).toStrictEqual({
    listen: '127.0.0.1:8500',
    tokenFile: '/t/tokens',
  });
});

test('it reads flags written with an equals sign', () => {
  const args = ['atc', 'daemon', '--listen=100.64.0.1:9000', '--token-file=/t/tokens'];

  expect(parseDaemonFlags(args)).toStrictEqual({
    listen: '100.64.0.1:9000',
    tokenFile: '/t/tokens',
  });
});

test('it reads null for flags the command line lacks', () => {
  expect(parseDaemonFlags(['atc', 'daemon'])).toStrictEqual({
    listen: null,
    tokenFile: null,
  });
});

test('it reads null for a flag that ends the command line without a value', () => {
  expect(parseDaemonFlags(['atc', 'daemon', '--listen'])).toStrictEqual({
    listen: null,
    tokenFile: null,
  });
});
