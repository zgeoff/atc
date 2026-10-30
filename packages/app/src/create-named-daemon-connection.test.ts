import { expect, mock, onTestFinished, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { createNamedDaemonConnection } from './create-named-daemon-connection';
import type { NamedDaemonChannel } from './create-named-daemon-connection';

test("it opens the tools' channel with no viewer", async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const openChannel = mock<(viewer: string | null) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve({
      onClose: () => {},
      onEvent: () => {},
      principal: undefined,
      sendHello: () => Promise.resolve({}),
      sendRequest,
      stop: () => {},
      procedures: { session: { get: mock(), watch: mock() } },
    }),
  );

  const connection = createNamedDaemonConnection({ name: 'box', openChannel });

  onTestFinished(() => connection.caller.stop());

  await connection.caller.sendRequest('session.list', undefined, {
    id: 'web-panel',
    name: 'Web panel',
  });

  expect(openChannel).toHaveBeenCalledExactlyOnceWith(null);
});

test('it gives two connectors that pass the same idempotency key different keys on the daemon', async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest,
        stop: () => {},
        procedures: { session: { get: mock(), watch: mock() } },
      }),
  });

  onTestFinished(() => connection.caller.stop());

  await connection.caller.sendRequest(
    'session.spawn',
    { cwd: '/srv/app', idempotencyKey: 'spawn-once' },
    { id: 'web-panel', name: 'Web panel' },
  );

  await connection.caller.sendRequest(
    'session.spawn',
    { cwd: '/srv/app', idempotencyKey: 'spawn-once' },
    { id: 'phone-app', name: 'Phone app' },
  );

  const keys = sendRequest.mock.calls.map((call) => call[1]?.['idempotencyKey']);

  expect(keys).toStrictEqual([expect.toStartWith('connector-'), expect.toStartWith('connector-')]);
  expect(keys[0]).not.toBe(keys[1]);
});

test('it gives one connector the same key on the daemon each time it passes a key', async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest,
        stop: () => {},
        procedures: { session: { get: mock(), watch: mock() } },
      }),
  });

  onTestFinished(() => connection.caller.stop());

  await connection.caller.sendRequest(
    'session.spawn',
    { cwd: '/srv/app', idempotencyKey: 'spawn-once' },
    { id: 'web-panel', name: 'Web panel' },
  );

  await connection.caller.sendRequest(
    'session.spawn',
    { cwd: '/srv/app', idempotencyKey: 'spawn-once' },
    { id: 'web-panel', name: 'Web panel' },
  );

  const keys = sendRequest.mock.calls.map((call) => call[1]?.['idempotencyKey']);

  expect(keys[1]).toBe(keys[0]);
});

test('it sends the key of a request that acts as no connector unchanged', async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest,
        stop: () => {},
        procedures: { session: { get: mock(), watch: mock() } },
      }),
  });

  onTestFinished(() => connection.caller.stop());

  await connection.caller.sendRequest('session.spawn', {
    cwd: '/srv/app',
    idempotencyKey: 'spawn-once',
  });

  expect(sendRequest.mock.calls[0]?.[1]).toStrictEqual({
    cwd: '/srv/app',
    idempotencyKey: 'spawn-once',
  });
});

test('it names the connector principal and the daemon when the daemon refuses a connector', () => {
  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest: () =>
          Promise.reject(
            new DaemonError('unauthorized', "principal 'phone-app' is not listed in principals"),
          ),
        stop: () => {},
        procedures: { session: { get: mock(), watch: mock() } },
      }),
  });

  onTestFinished(() => connection.caller.stop());

  expect(
    connection.caller.sendRequest('session.list', undefined, {
      id: 'phone-app',
      name: 'Phone app',
    }),
  ).rejects.toMatchObject({
    code: 'unauthorized',
    message:
      "daemon 'box' refused a request as the connector principal 'phone-app': principal 'phone-app' is not listed in principals",
  });
});

test.each([
  {
    refusal: 'an unauthorized refusal of a request that acts as no connector',
    code: 'unauthorized',
    principal: undefined,
  },
  {
    refusal: 'a refusal of a connector with another code',
    code: 'no_such_session',
    principal: { id: 'phone-app', name: 'Phone app' },
  },
])('it passes $refusal through unchanged', (row) => {
  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest: () => Promise.reject(new DaemonError(row.code, 'the daemon said no')),
        stop: () => {},
        procedures: { session: { get: mock(), watch: mock() } },
      }),
  });

  onTestFinished(() => connection.caller.stop());

  expect(
    connection.caller.sendRequest('session.list', undefined, row.principal),
  ).rejects.toMatchObject({ code: row.code, message: 'the daemon said no' });
});

test('it opens a live-terminal channel with no viewer when the viewer gives no principal', async () => {
  const openChannel = mock<(viewer: string | null) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve({
      onClose: () => {},
      onEvent: () => {},
      principal: 'laptop',
      sendHello: () => Promise.resolve({}),
      sendRequest: () => Promise.resolve({}),
      stop: () => {},
      procedures: { session: { get: mock(), watch: mock() } },
    }),
  );

  const connection = createNamedDaemonConnection({ name: 'box', openChannel });

  await connection.openWatchChannel(null);

  expect(openChannel).toHaveBeenCalledExactlyOnceWith(null);
});

test('it opens a live-terminal channel narrowed to its viewer, whose requests act as the viewer', async () => {
  const watched: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: 'laptop',
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get: mock(), watch: mock() } },
  };

  const openChannel = mock<(viewer: string | null) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve(watched),
  );

  const connection = createNamedDaemonConnection({ name: 'box', openChannel });

  const channel = await connection.openWatchChannel('web-panel');

  expect(openChannel).toHaveBeenCalledExactlyOnceWith('web-panel');
  expect(channel).toBe(watched);
  expect(watched.principal).toBe('web-panel');
});
