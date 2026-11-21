import { expect, mock, onTestFinished, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { openDaemonConnection } from '@atcx/client/connection';
import type { DaemonConnection } from '@atcx/client/connection';
import { startStubDaemon } from '@atcx/client/test-utils/start-stub-daemon';
import { waitFor } from '@zgeoff/testing';
import { createDaemonTransport } from './create-daemon-transport';

async function setupTest() {
  const daemon = await startStubDaemon();

  onTestFinished(() => daemon.stop());

  const openConnection = async (): Promise<DaemonConnection> => {
    const connection = await openDaemonConnection({ path: daemon.path }, { client: 'atc/test' });

    onTestFinished(() => connection.close());

    return connection;
  };

  return { daemon, openConnection };
}

test('it opens one connection for requests that wait together and hands each the same one', async () => {
  const ctx = await setupTest();

  const open = mock(() => ctx.openConnection());

  const transport = createDaemonTransport({
    open,
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  onTestFinished(() => {
    transport.stop();
  });

  const [first, second] = await Promise.all([
    transport.waitForConnection(),
    transport.waitForConnection(),
  ]);

  expect(first).toBe(second);
  expect(open).toHaveBeenCalledOnce();
  expect(transport.readState()).toBe('ready');
});

test('it rejects every request that waited on an on-demand open that failed and opens afresh for the next one', async () => {
  const ctx = await setupTest();

  const open = mock<() => Promise<DaemonConnection>>();

  open.mockImplementationOnce(() => Promise.reject(new Error('no daemon listens')));
  open.mockImplementationOnce(() => ctx.openConnection());

  const transport = createDaemonTransport({
    open,
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  onTestFinished(() => {
    transport.stop();
  });

  const settled = await Promise.allSettled([
    transport.waitForConnection(),
    transport.waitForConnection(),
  ]);

  const reopened = await transport.waitForConnection();

  expect(settled.map((result) => result.status)).toStrictEqual(['rejected', 'rejected']);
  expect(reopened.hello.daemonID).toBe('d_stub');
});

test('it marks a connection lost once it closes and opens a fresh one for the next on-demand request', async () => {
  const ctx = await setupTest();

  const transport = createDaemonTransport({
    open: () => ctx.openConnection(),
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  onTestFinished(() => {
    transport.stop();
  });

  const first = await transport.waitForConnection();

  await first.close();

  await waitFor(() => {
    expect(transport.isLost(first)).toBeTrue();
  });

  const idleAfterLoss = transport.readState();

  const reopened = await transport.waitForConnection();

  expect(idleAfterLoss).toBe('idle');
  expect(reopened).not.toBe(first);
  expect(transport.isLost(reopened)).toBeFalse();
});

test('it keeps a newer connection in place when the one it replaced closes late', async () => {
  const ctx = await setupTest();

  const transport = createDaemonTransport({
    open: () => ctx.openConnection(),
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  onTestFinished(() => {
    transport.stop();
  });

  const first = await transport.waitForConnection();

  transport.stopConnection(first);

  const second = await transport.waitForConnection();

  await first.closed;

  const kept = await transport.waitForConnection();

  expect(transport.readState()).toBe('ready');
  expect(kept).toBe(second);
  expect(transport.isLost(first)).toBeTrue();
});

test('it reconnects an always transport after the backoff its clock runs and reports the loss and the new connection', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);
  const ready = mock<(connection: DaemonConnection) => void>();
  const lost = mock<(connection: DaemonConnection) => void>();

  const transport = createDaemonTransport({
    open: () => ctx.openConnection(),
    getConnection: (connection) => connection,
    reconnect: 'always',
    backoffMs: [50],
    clock,
    onReady: ready,
    onLost: lost,
  });

  onTestFinished(() => {
    transport.stop();
  });

  const first = await transport.waitForConnection();

  await first.close();

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([50]);
  });

  clock.advance(50);

  const reconnected = await transport.waitForConnection();

  expect(reconnected).not.toBe(first);
  expect(lost).toHaveBeenCalledExactlyOnceWith(first);
  expect(ready.mock.calls).toStrictEqual([[first], [reconnected]]);
});

test('it waits longer after each failed always open in a row, keeps the last wait, and tells each open how many opened before it', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  const connection = await ctx.openConnection();

  const open = mock<(opened: number) => Promise<DaemonConnection>>();
  const failures: boolean[] = [];

  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.resolve(connection));

  const transport = createDaemonTransport({
    open,
    getConnection: (opened) => opened,
    reconnect: 'always',
    backoffMs: [0, 100, 400],
    clock,
    onOpenFailed: (_error, fatal) => {
      failures.push(fatal);
    },
  });

  onTestFinished(() => {
    transport.stop();
  });

  const connected = transport.waitForConnection();

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([400]);
  });

  clock.advance(400);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([400]);
  });

  clock.advance(400);

  const opened = await connected;

  expect(opened).toBe(connection);
  expect(clock.collectDelays()).toStrictEqual([100, 400, 400]);
  expect(failures).toStrictEqual([false, false, false]);
  expect(open.mock.calls).toStrictEqual([[0], [0], [0], [0]]);
});

test('it closes for good and rejects the waiting request on a fatal open failure', async () => {
  const open = mock(() => Promise.reject(new Error('the daemon refused the token')));

  const transport = createDaemonTransport<DaemonConnection>({
    open,
    getConnection: (connection) => connection,
    reconnect: 'always',
    isFatal: () => true,
  });

  expect(transport.waitForConnection()).rejects.toThrow('the daemon refused the token');

  await expect(transport.waitForConnection()).toReject();

  expect(transport.readState()).toBe('closed');
  expect(open).toHaveBeenCalledOnce();
});

test('it closes the open connection and rejects later requests once stopped', async () => {
  const ctx = await setupTest();

  const transport = createDaemonTransport({
    open: () => ctx.openConnection(),
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  await transport.waitForConnection();

  transport.stop();

  await waitFor(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });

  expect(transport.waitForConnection()).rejects.toThrow('the daemon transport is stopped');
});

test('it closes a connection that finishes opening after the transport stopped', async () => {
  const ctx = await setupTest();
  const connection = await ctx.openConnection();

  const gate = Promise.withResolvers<DaemonConnection>();

  const transport = createDaemonTransport({
    open: () => gate.promise,
    getConnection: (opened) => opened,
    reconnect: 'on-demand',
  });

  const connected = transport.waitForConnection();

  transport.stop();
  gate.resolve(connection);

  expect(connected).rejects.toThrow('the daemon transport is stopped');

  await waitFor(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });
});

test('it counts a connection that ended before the transport followed it as lost', async () => {
  const ctx = await setupTest();
  const ended = await ctx.openConnection();

  await ended.close();

  const transport = createDaemonTransport({
    open: () => Promise.resolve(ended),
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  const connected = await transport.waitForConnection();

  await waitFor(() => {
    expect(transport.isLost(ended)).toBeTrue();
  });

  expect(connected).toBe(ended);
  expect(transport.readState()).toBe('idle');
});

test('it keeps the latest connection after it is lost and holds none before the first opens', async () => {
  const ctx = await setupTest();

  const transport = createDaemonTransport({
    open: () => ctx.openConnection(),
    getConnection: (connection) => connection,
    reconnect: 'on-demand',
  });

  onTestFinished(() => {
    transport.stop();
  });

  const before = transport.findLatest();

  const connection = await transport.waitForConnection();

  await connection.close();

  await waitFor(() => {
    expect(transport.isLost(connection)).toBeTrue();
  });

  expect(before).toBeNull();
  expect(transport.findLatest()).toBe(connection);
});
