import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { makeDaemonReadySignal } from './make-daemon-ready-signal';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-ready-signal-');

  return { directory: temporaryDirectory.path };
}

test('it writes one ready line to the pipe the variable names, and closes the pipe while the daemon runs', async () => {
  const ctx = setupTest();
  const daemonScript = join(ctx.directory, 'daemon.ts');

  writeFileSync(
    daemonScript,
    `import { makeDaemonReadySignal } from '${join(import.meta.dir, 'make-daemon-ready-signal.ts')}';
const signalReady = makeDaemonReadySignal(process.env);
signalReady();
signalReady();
setInterval(() => {}, 1000);
`,
  );

  const daemon = spawn(process.execPath, [daemonScript], {
    env: { ...process.env, ATC_DAEMON_READY_FD: '3' },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });

  registerTestCleanup(async () => {
    const exited = once(daemon, 'exit');

    daemon.kill('SIGKILL');

    await exited;
  });

  const pipe = daemon.stdio.at(3);

  invariant(pipe instanceof Readable);

  const chunks: unknown[] = await pipe.toArray();

  expect(chunks.map(String).join('')).toBe('ready\n');
  expect(daemon.exitCode).toBeNull();
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
