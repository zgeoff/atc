import { expect, mock, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { setupTempDir, startStubLegacyDaemon } from '@atc/test-utils';
import { runDaemonBackup } from './run-daemon-backup';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';

function setupTest() {
  const tmp = setupTempDir('run-daemon-backup-');

  const host = buildMockLifecycleHost({
    paths: resolvePaths({ HOME: tmp.dir, XDG_RUNTIME_DIR: tmp.dir }),
  });

  return { host };
}

test('it sends the path to the daemon and prints what the daemon wrote', async () => {
  const ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, {
    replies: {
      'daemon.hello': { daemon: 'atc/1.2.3', daemonID: 'd-1' },
      'daemon.backup': { path: '/srv/backups/atc.db', bytes: 4096 },
    },
  });

  const io = { print: mock(), printError: mock() };

  const code = await runDaemonBackup(ctx.host, '/srv/backups/atc.db', io);

  expect(code).toBe(0);

  expect(daemon.requests).toContainEqual({
    m: 'daemon.backup',
    p: { path: '/srv/backups/atc.db' },
  });

  expect(io.print).toHaveBeenCalledExactlyOnceWith(
    'atc backup: wrote 4096 bytes to /srv/backups/atc.db',
  );

  expect(io.printError).not.toHaveBeenCalled();
});

test('it refuses with a hint when no daemon runs, without starting one', async () => {
  const ctx = setupTest();
  const io = { print: mock(), printError: mock() };

  const code = await runDaemonBackup(ctx.host, '/srv/backups/atc.db', io);

  expect(code).toBe(1);

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    `atc backup: no daemon at ${ctx.host.paths.daemonSocketPath} — start one first`,
  );
});

test("it prints the daemon's refusal of the backup request with its code", async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, {
    replies: { 'daemon.hello': { daemon: 'atc/1.2.3', daemonID: 'd-1' } },
  });

  const io = { print: mock(), printError: mock() };

  const code = await runDaemonBackup(ctx.host, '/srv/backups/atc.db', io);

  expect(code).toBe(1);

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    "atc backup: unknown_method: unknown method 'daemon.backup'",
  );
});

test('it prints the refusal of a daemon on another protocol', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, { protocol: PROTOCOL_V + 1 });

  const io = { print: mock(), printError: mock() };

  const code = await runDaemonBackup(ctx.host, '/srv/backups/atc.db', io);

  expect(code).toBe(1);

  expect(io.printError).toHaveBeenCalledExactlyOnceWith(
    `atc backup: atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  );
});

test('it prints the error when the daemon closes the connection before it answers', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, {
    replies: { 'daemon.hello': { daemon: 'atc/1.2.3', daemonID: 'd-1' } },
    closeOnRequest: 'daemon.backup',
  });

  const io = { print: mock(), printError: mock() };

  const code = await runDaemonBackup(ctx.host, '/srv/backups/atc.db', io);

  expect(code).toBe(1);
  expect(io.printError).toHaveBeenCalledExactlyOnceWith('atc backup: internal: connection closed');
});
