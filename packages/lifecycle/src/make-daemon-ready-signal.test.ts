import { expect, test } from 'bun:test';
import { fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { makeDaemonReadySignal } from './make-daemon-ready-signal';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-ready-signal-');

  return { directory: temporaryDirectory.path };
}

test('it writes one ready line to the descriptor the variable names, and closes it', () => {
  const ctx = setupTest();
  const readyFile = join(ctx.directory, 'ready');
  const fd = openSync(readyFile, 'w');
  const signalReady = makeDaemonReadySignal({ ATC_DAEMON_READY_FD: String(fd) });

  signalReady();
  signalReady();

  expect(readFileSync(readyFile, 'utf8')).toBe('ready\n');
  expect(() => fstatSync(fd)).toThrow();
});

test('it removes the variable from the environment it is given', () => {
  const env: Record<string, string | undefined> = { ATC_DAEMON_READY_FD: '9', PATH: '/usr/bin' };

  makeDaemonReadySignal(env);

  expect(env).toStrictEqual({ PATH: '/usr/bin' });
});

test.each([
  ['standard output', '1'],
  ['an empty value', ''],
  ['a value that is not a number', 'pipe'],
])('it leaves the standard streams open when the variable holds %s', (_label, value) => {
  makeDaemonReadySignal({ ATC_DAEMON_READY_FD: value })();

  expect(() => [0, 1, 2].map((fd) => fstatSync(fd))).not.toThrow();
});

test('it signals nothing and throws nothing when no client set the variable', () => {
  expect(makeDaemonReadySignal({})).not.toThrow();
});
