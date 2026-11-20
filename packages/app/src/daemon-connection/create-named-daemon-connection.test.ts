import { expect, mock, onTestFinished, test } from 'bun:test';
import { openDaemonConnection } from '@atcx/client/connection';
import { startStubDaemon } from '@atcx/client/test-utils/start-stub-daemon';
import { AtcError } from '@atcx/contract/light';
import { createNamedDaemonConnection } from './create-named-daemon-connection';
import type { NamedDaemonChannel } from './create-named-daemon-connection';

async function setupTest() {
  const daemon = await startStubDaemon();

  onTestFinished(() => daemon.stop());

  const connection = await openDaemonConnection({ path: daemon.path }, { client: 'atc/test' });

  onTestFinished(() => connection.close());

  return { connection };
}

test("it opens the tools' channel with no viewer", async () => {
  const ctx = await setupTest();

  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const openChannel = mock<(viewer: string | null) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve({
      connection: ctx.connection,
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
  const ctx = await setupTest();

  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
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

test('it gives one connector that passes two idempotency keys two different keys on the daemon', async () => {
  const ctx = await setupTest();

  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
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
    { cwd: '/srv/app', idempotencyKey: 'spawn-first' },
    { id: 'web-panel', name: 'Web panel' },
  );

  await connection.caller.sendRequest(
    'session.spawn',
    { cwd: '/srv/app', idempotencyKey: 'spawn-second' },
    { id: 'web-panel', name: 'Web panel' },
  );

  const keys = sendRequest.mock.calls.map((call) => call[1]?.['idempotencyKey']);

  expect(keys).toStrictEqual([expect.toStartWith('connector-'), expect.toStartWith('connector-')]);
  expect(keys[0]).not.toBe(keys[1]);
});

test('it gives one connector the same key on the daemon each time it passes a key', async () => {
  const ctx = await setupTest();

  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
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
  const ctx = await setupTest();

  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
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

test('it names the connector principal and the daemon when the daemon refuses a connector', async () => {
  const ctx = await setupTest();

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest: () =>
          Promise.reject(
            new AtcError('unauthorized', "principal 'phone-app' is not listed in principals"),
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
])('it passes $refusal through unchanged', async (row) => {
  const ctx = await setupTest();

  const connection = createNamedDaemonConnection({
    name: 'box',
    openChannel: () =>
      Promise.resolve({
        connection: ctx.connection,
        onClose: () => {},
        onEvent: () => {},
        principal: undefined,
        sendHello: () => Promise.resolve({}),
        sendRequest: () => Promise.reject(new AtcError(row.code, 'the daemon said no')),
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
  const ctx = await setupTest();

  const openChannel = mock<(viewer: string | null) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve({
      connection: ctx.connection,
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
  const ctx = await setupTest();

  const watched: NamedDaemonChannel = {
    connection: ctx.connection,
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
