import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { resolveATCCommand, setupTempDir, waitFor } from '@atc/test-utils';
import type { DaemonEvent } from '@atcx/contract';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';
import { startDaemonProcess } from './testing/start-daemon-process';
import { writeRestartEvent } from './write-restart-event';

function setupTest() {
  const temporaryDirectory = setupTempDir('write-restart-event-');

  const host = buildMockLifecycleHost({
    paths: resolvePaths({
      HOME: temporaryDirectory.path,
      XDG_RUNTIME_DIR: temporaryDirectory.path,
    }),
  });

  return { home: temporaryDirectory.path, host };
}

test('it puts the restart result on the feed of the daemon that answers', async () => {
  const ctx = setupTest();
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: ctx.home });

  const watcher = await daemon.openClient();

  const events: DaemonEvent[] = [];

  watcher.onEvent = (event) => {
    events.push(event);
  };

  await watcher.sendHello('atc/test');

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

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'DaemonRestarted' });
  });

  expect(outcome).toStrictEqual({ kind: 'sent' });

  expect(events.filter((event) => event.ev === 'DaemonRestarted')).toStrictEqual([
    { ev: 'DaemonRestarted', result },
  ]);
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

test('it reports a failure with the refusal when the daemon refuses the handshake', async () => {
  const host = buildMockLifecycleHost({
    openDaemon: () =>
      Promise.resolve({
        kind: 'refused',
        socketPath: '/run/user/1000/atc-daemon.sock',
        message: 'atc/test-build speaks protocol v9, daemon atc/0.8.0 speaks v8',
      }),
  });

  const outcome = await writeRestartEvent(host, {
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

  expect(outcome).toStrictEqual({
    kind: 'failed',
    reason: 'atc/test-build speaks protocol v9, daemon atc/0.8.0 speaks v8',
  });
});

test('it reports a failure with the error when the send fails', async () => {
  const host = buildMockLifecycleHost({
    openDaemon: () => Promise.reject(new Error('the daemon closed the connection')),
  });

  const outcome = await writeRestartEvent(host, {
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

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'the daemon closed the connection' });
});
