import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// The legacy daemon started on a socket in a temp directory, which is also
// its state directory. Cleanup kills the daemon, then removes the directory.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-legacy-');
  const socketPath = join(temporaryDirectory.path, 'daemon.sock');

  const subprocess = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-stub-legacy-daemon.ts'),
      socketPath,
      temporaryDirectory.path,
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  registerTestCleanup(async () => {
    subprocess.kill();

    await subprocess.exited;
  });

  return { directory: temporaryDirectory.path, socketPath, subprocess };
}

test('it prints up and the pid of the session it hosts once it listens', async () => {
  const ctx = setupTest();

  const printed = await ctx.subprocess.stdout.getReader().read();

  expect(new TextDecoder().decode(printed.value)).toMatch(/^up \d+\n$/u);
});

test('it keeps the session it hosts running while it runs', async () => {
  const ctx = setupTest();

  const printed = await ctx.subprocess.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(printed.value).trim().split(' ')[1]);

  expect(() => process.kill(sessionPID, 0)).not.toThrow();
});

test('it records its pid and sockets in the state directory the way a daemon records itself', async () => {
  const ctx = setupTest();

  await ctx.subprocess.stdout.getReader().read();

  const record: unknown = JSON.parse(readFileSync(join(ctx.directory, 'daemon.json'), 'utf8'));

  expect(record).toStrictEqual({
    pid: ctx.subprocess.pid,
    socketPath: ctx.socketPath,
    reporterSocketPath: `${ctx.socketPath}.reporter`,
    eventsSocketPath: null,
    listenPort: null,
  });
});

test('it refuses a handshake on the current protocol with protocol_mismatch', async () => {
  const ctx = setupTest();

  await ctx.subprocess.stdout.getReader().read();

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  });
});

test('it answers a handshake on the current protocol as an older build when told to speak it', async () => {
  const ctx = setupTest();
  const socketPath = join(ctx.directory, 'current.sock');

  const current = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-stub-legacy-daemon.ts'),
      socketPath,
      ctx.directory,
      'current',
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  registerTestCleanup(async () => {
    current.kill();

    await current.exited;
  });

  await current.stdout.getReader().read();

  const client = await openDaemonClient(socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).resolves.toMatchObject({ daemon: 'atc/legacy-build' });
});

test('it stops with a usage error when given no socket path and state directory', async () => {
  const run = await runCommand([
    process.execPath,
    join(import.meta.dir, 'run-stub-legacy-daemon.ts'),
  ]);

  expect({ exitCode: run.exitCode, stderr: run.stderr }).toStrictEqual({
    exitCode: 1,
    stderr: expect.toInclude('usage: run-stub-legacy-daemon.ts <socket path> <state dir>'),
  });
});

test.each([['SIGTERM'], ['SIGINT']] as const)(
  'it ends the session it hosts when %p stops it',
  async (signal) => {
    const ctx = setupTest();

    const printed = await ctx.subprocess.stdout.getReader().read();

    const sessionPID = Number(new TextDecoder().decode(printed.value).trim().split(' ')[1]);

    ctx.subprocess.kill(signal);

    await ctx.subprocess.exited;

    await waitFor(() => {
      expect(() => process.kill(sessionPID, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  },
);

test('it dies of the signal that stopped it', async () => {
  const ctx = setupTest();

  await ctx.subprocess.stdout.getReader().read();

  ctx.subprocess.kill('SIGTERM');

  await ctx.subprocess.exited;

  expect(ctx.subprocess.signalCode).toBe('SIGTERM');
});
