import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { PROTOCOL_V } from '../protocol/protocol';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

// The legacy daemon started on a socket in a temp directory, which is also
// its state directory. Cleanup kills the daemon, then removes the directory.
function setupTest() {
  const tmp = setupTempDir('atc-run-legacy-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'run-stub-legacy-daemon.ts'), socketPath, tmp.dir],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  registerTestCleanup(async () => {
    proc.kill();

    await proc.exited;
  });

  return { dir: tmp.dir, socketPath, proc };
}

test('it prints up and the pid of the session it hosts once it listens', async () => {
  const ctx = setupTest();

  const printed = await ctx.proc.stdout.getReader().read();

  expect(new TextDecoder().decode(printed.value)).toMatch(/^up \d+\n$/u);
});

test('it keeps the session it hosts running while it runs', async () => {
  const ctx = setupTest();

  const printed = await ctx.proc.stdout.getReader().read();

  const sessionPID = Number(new TextDecoder().decode(printed.value).trim().split(' ')[1]);

  expect(() => process.kill(sessionPID, 0)).not.toThrow();
});

test('it records its pid and sockets in the state directory the way a daemon records itself', async () => {
  const ctx = setupTest();

  await ctx.proc.stdout.getReader().read();

  const record: unknown = JSON.parse(readFileSync(join(ctx.dir, 'daemon.json'), 'utf8'));

  expect(record).toStrictEqual({
    pid: ctx.proc.pid,
    socketPath: ctx.socketPath,
    reporterSocketPath: `${ctx.socketPath}.reporter`,
    eventsSocketPath: null,
    listenPort: null,
  });
});

test('it refuses a handshake on the current protocol with protocol_mismatch', async () => {
  const ctx = setupTest();

  await ctx.proc.stdout.getReader().read();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  });
});

test('it stops with a usage error when given no socket path and state directory', () => {
  const run = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'run-stub-legacy-daemon.ts')],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.toInclude('usage: run-stub-legacy-daemon.ts <socket path> <state dir>'),
  });
});

test.each([['SIGTERM'], ['SIGINT']] as const)(
  'it ends the session it hosts when %p stops it',
  async (signal) => {
    const ctx = setupTest();

    const printed = await ctx.proc.stdout.getReader().read();

    const sessionPID = Number(new TextDecoder().decode(printed.value).trim().split(' ')[1]);

    ctx.proc.kill(signal);

    await ctx.proc.exited;

    await waitFor(() => {
      expect(() => process.kill(sessionPID, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  },
);

test('it dies of the signal that stopped it', async () => {
  const ctx = setupTest();

  await ctx.proc.stdout.getReader().read();

  ctx.proc.kill('SIGTERM');

  await ctx.proc.exited;

  expect(ctx.proc.signalCode).toBe('SIGTERM');
});
