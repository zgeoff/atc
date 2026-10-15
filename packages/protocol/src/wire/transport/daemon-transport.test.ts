import { expect, mock, test } from 'bun:test';
import { buildStubClock, waitFor } from '@atc/test-utils';
import { DaemonTransport } from './daemon-transport';
import type { TransportChannel } from './daemon-transport';

test('it opens one connection for requests that wait together and hands each the same one', async () => {
  const channel = { onClose: () => {}, stop: mock() };
  const open = mock(() => Promise.resolve(channel));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  const [first, second] = await Promise.all([
    transport.waitForConnection(),
    transport.waitForConnection(),
  ]);

  expect(first).toBe(channel);
  expect(second).toBe(channel);
  expect(open).toHaveBeenCalledOnce();
  expect(transport.readState()).toBe('ready');
});

test('it rejects every request that waited on an on-demand open that failed and opens afresh for the next one', async () => {
  const channel = { onClose: () => {}, stop: mock() };
  const open = mock<() => Promise<typeof channel>>();

  open.mockImplementationOnce(() => Promise.reject(new Error('no daemon listens')));
  open.mockImplementationOnce(() => Promise.resolve(channel));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  const failed = Promise.allSettled([transport.waitForConnection(), transport.waitForConnection()]);

  const settled = await failed;
  const reopened = await transport.waitForConnection();

  expect(settled.map((result) => result.status)).toStrictEqual(['rejected', 'rejected']);
  expect(reopened).toBe(channel);
});

test('it marks a connection lost once it closes and opens a fresh one for the next on-demand request', async () => {
  const first = { onClose: () => {}, stop: mock() };
  const second = { onClose: () => {}, stop: mock() };
  const open = mock<() => Promise<typeof first>>();

  open.mockImplementationOnce(() => Promise.resolve(first));
  open.mockImplementationOnce(() => Promise.resolve(second));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  await transport.waitForConnection();

  first.onClose();

  const idleAfterLoss = transport.readState();

  const reopened = await transport.waitForConnection();

  expect(idleAfterLoss).toBe('idle');
  expect(transport.isLost(first)).toBeTrue();
  expect(reopened).toBe(second);
  expect(transport.isLost(second)).toBeFalse();
});

test('it keeps a newer connection in place when the one it replaced closes late', async () => {
  const first = { onClose: () => {}, stop: mock() };
  const second = { onClose: () => {}, stop: mock() };
  const open = mock<() => Promise<typeof first>>();

  open.mockImplementationOnce(() => Promise.resolve(first));
  open.mockImplementationOnce(() => Promise.resolve(second));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  await transport.waitForConnection();

  transport.stopConnection(first);

  await transport.waitForConnection();

  first.onClose();

  const kept = await transport.waitForConnection();

  expect(transport.readState()).toBe('ready');
  expect(kept).toBe(second);
  expect(first.stop).toHaveBeenCalledOnce();
});

test('it reconnects an always transport after the backoff its clock runs and reports the loss and the new connection', async () => {
  const clock = buildStubClock(0);
  const first = { onClose: () => {}, stop: mock() };
  const second = { onClose: () => {}, stop: mock() };
  const open = mock<() => Promise<typeof first>>();
  const ready = mock<(connection: unknown) => void>();
  const lost = mock<(connection: unknown) => void>();

  open.mockImplementationOnce(() => Promise.resolve(first));
  open.mockImplementationOnce(() => Promise.resolve(second));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'always',
    backoffMs: [50],
    clock,
    onReady: ready,
    onLost: lost,
  });

  await transport.waitForConnection();

  first.onClose();

  const pending = clock.collectPending();

  clock.advance(50);

  const reconnected = await transport.waitForConnection();

  expect(reconnected).toBe(second);
  expect(pending).toStrictEqual([50]);
  expect(lost).toHaveBeenCalledExactlyOnceWith(first);
  expect(ready.mock.calls).toStrictEqual([[first], [second]]);
});

test('it waits longer after each failed always open in a row, keeps the last wait, and tells each open how many opened before it', async () => {
  const clock = buildStubClock(0);
  const channel = { onClose: () => {}, stop: mock() };
  const open = mock<(opened: number) => Promise<typeof channel>>();
  const failures: boolean[] = [];

  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.reject(new Error('daemon starting')));
  open.mockImplementationOnce(() => Promise.resolve(channel));

  const transport = new DaemonTransport({
    open,
    getChannel: (connection) => connection,
    reconnect: 'always',
    backoffMs: [0, 100, 400],
    clock,
    onOpenFailed: (_error, fatal) => {
      failures.push(fatal);
    },
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

  expect(opened).toBe(channel);
  expect(clock.collectDelays()).toStrictEqual([100, 400, 400]);
  expect(failures).toStrictEqual([false, false, false]);
  expect(open.mock.calls).toStrictEqual([[0], [0], [0], [0]]);
});

test('it closes for good and rejects the waiting request on a fatal open failure', async () => {
  const open = mock(() => Promise.reject(new Error('the daemon refused the token')));

  const transport = new DaemonTransport<TransportChannel>({
    open,
    getChannel: (connection) => connection,
    reconnect: 'always',
    isFatal: () => true,
  });

  expect(transport.waitForConnection()).rejects.toThrow('the daemon refused the token');

  await expect(transport.waitForConnection()).toReject();

  expect(transport.readState()).toBe('closed');
  expect(open).toHaveBeenCalledOnce();
});

test('it closes the open connection and rejects later requests once stopped', async () => {
  const channel = { onClose: () => {}, stop: mock() };

  const transport = new DaemonTransport({
    open: () => Promise.resolve(channel),
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  await transport.waitForConnection();

  transport.stop();

  expect(channel.stop).toHaveBeenCalledOnce();
  expect(transport.waitForConnection()).rejects.toThrow('the daemon transport is stopped');
});

test('it closes a connection that finishes opening after the transport stopped', async () => {
  const channel = { onClose: () => {}, stop: mock() };
  const gate = Promise.withResolvers<typeof channel>();

  const transport = new DaemonTransport({
    open: () => gate.promise,
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  const connected = transport.waitForConnection();

  transport.stop();
  gate.resolve(channel);

  expect(connected).rejects.toThrow('the daemon transport is stopped');

  await waitFor(() => {
    expect(channel.stop).toHaveBeenCalledOnce();
  });
});

test('it counts a connection that ended before the transport followed it as lost at once', async () => {
  const channel = { onClose: () => {}, stop: mock(), isClosed: () => true };

  const transport = new DaemonTransport({
    open: () => Promise.resolve(channel),
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  const connected = await transport.waitForConnection();

  expect(connected).toBe(channel);
  expect(transport.isLost(channel)).toBeTrue();
  expect(transport.readState()).toBe('idle');
});

test('it keeps the latest connection after it is lost and holds none before the first opens', async () => {
  const channel = { onClose: () => {}, stop: mock() };

  const transport = new DaemonTransport({
    open: () => Promise.resolve(channel),
    getChannel: (connection) => connection,
    reconnect: 'on-demand',
  });

  const before = transport.findLatest();

  await transport.waitForConnection();

  channel.onClose();

  expect(before).toBeNull();
  expect(transport.findLatest()).toBe(channel);
});
