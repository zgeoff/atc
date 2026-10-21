import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { setupTempDir, startStubLegacyDaemon } from '@atc/test-utils';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';
import { writeRestartEvent } from './write-restart-event';

function setupTest() {
  const temporaryDirectory = setupTempDir('write-restart-event-');

  const host = buildMockLifecycleHost({
    paths: resolvePaths({
      HOME: temporaryDirectory.path,
      XDG_RUNTIME_DIR: temporaryDirectory.path,
    }),
  });

  return { host };
}

test('it sends the restart result to the daemon that answers', async () => {
  const ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, {
    replies: { 'daemon.restarted': {} },
  });

  const result = {
    runID: 'run-maple',
    code: 1,
    pid: 4242,
    build: 'atc/0.9.1',
    listenPort: null,
    restored: 1,
    total: 2,
    failed: [{ name: 'heron', id: 's-heron', reason: 'its agent is not configured' }],
    interrupted: [{ name: 'wren', id: 's-wren' }],
    error: null,
  };

  const outcome = await writeRestartEvent(ctx.host, result);

  expect(outcome).toStrictEqual({ kind: 'sent' });
  expect(daemon.requests).toContainEqual({ method: 'daemon.restarted', params: { result } });
});

test('it reports no daemon when nothing listens on the socket', async () => {
  const ctx = setupTest();

  const outcome = await writeRestartEvent(ctx.host, {
    runID: 'run-maple',
    code: 1,
    pid: null,
    build: null,
    listenPort: null,
    restored: 0,
    total: 0,
    failed: [],
    interrupted: [],
    error: 'no replacement daemon answered within 30 s',
  });

  expect(outcome).toStrictEqual({ kind: 'no_daemon' });
});

test('it reports a failure when the daemon refuses the handshake', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.host.paths.daemonSocketPath, { protocol: 1 });

  const outcome = await writeRestartEvent(ctx.host, {
    runID: 'run-maple',
    code: 0,
    pid: 4242,
    build: 'atc/0.9.1',
    listenPort: null,
    restored: 0,
    total: 0,
    failed: [],
    interrupted: [],
    error: null,
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: expect.toInclude('protocol') });
});
