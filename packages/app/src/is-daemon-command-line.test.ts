import { expect, test } from 'bun:test';
import { isDaemonCommandLine } from './is-daemon-command-line';

test('it accepts the installed binary running the daemon with listener flags', () => {
  expect(
    isDaemonCommandLine([
      '/home/u/.local/bin/atc',
      'daemon',
      '--listen',
      '127.0.0.1:8415',
      '--token-file',
      '/t',
    ]),
  ).toBeTrue();
});

test('it accepts a compiled release binary running the daemon', () => {
  expect(isDaemonCommandLine(['/opt/atc-linux-x64', 'daemon'])).toBeTrue();
});

test('it accepts the source entry under bun running daemon serve', () => {
  expect(isDaemonCommandLine(['/usr/bin/bun', '/repo/src/cli.ts', 'daemon', 'serve'])).toBeTrue();
});

test('it accepts the bin shim under bun running the daemon', () => {
  expect(isDaemonCommandLine(['bun', '/repo/bin/atc', 'daemon'])).toBeTrue();
});

test('it rejects an inline script that passes a daemon argument', () => {
  expect(isDaemonCommandLine(['bun', '-e', 'setInterval(() => {}, 1000)', 'daemon'])).toBeFalse();
});

test('it rejects another program whose first argument is daemon', () => {
  expect(isDaemonCommandLine(['/usr/bin/sleep', 'daemon'])).toBeFalse();
});

test('it rejects another atc subcommand that takes daemon as a value', () => {
  expect(isDaemonCommandLine(['/usr/bin/atc', 'daemon', 'restart'])).toBeFalse();
});
