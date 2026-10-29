import { expect, mock, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import { DaemonError } from '@atc/protocol/wire';
import {
  buildMockAgentAdapter,
  buildMockSessionDescriptor,
  getRecord,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import type { DaemonEvent } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { createNamedDaemonConnection } from './create-named-daemon-connection';
import type { NamedDaemonChannel } from './create-named-daemon-connection';
import { makeRemoteChannelOpener } from './make-remote-channel-opener';
import { buildLocalTarget } from './test-utils/build-local-target';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';
import { startTestDaemon } from './test-utils/start-test-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-named-daemon-');

  return { tokenFile: join(temporaryDirectory.path, 'box.token') };
}

test("it opens the tools' channel as the entry principal", async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const openChannel = mock<(principal: string) => Promise<NamedDaemonChannel>>(() =>
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

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    openChannel,
    printError: () => {},
  });

  onTestFinished(() => connection.caller.stop());

  await connection.caller.sendRequest('session.list');

  expect(openChannel).toHaveBeenCalledExactlyOnceWith('laptop');
});

test('it gives two connectors that pass the same idempotency key different keys on the daemon', async () => {
  const sendRequest = mock<NamedDaemonChannel['sendRequest']>(() => Promise.resolve({}));

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
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
    principal: 'laptop',
    printError: () => {},
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
    principal: 'laptop',
    printError: () => {},
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
    principal: 'laptop',
    printError: () => {},
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
    principal: 'laptop',
    printError: () => {},
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

test('it opens a live-terminal channel as the entry principal when the viewer gives none', async () => {
  const openChannel = mock<(principal: string) => Promise<NamedDaemonChannel>>(() =>
    Promise.resolve({
      onClose: () => {},
      onEvent: () => {},
      principal: undefined,
      sendHello: () => Promise.resolve({}),
      sendRequest: () => Promise.resolve({}),
      stop: () => {},
      procedures: { session: { get: mock(), watch: mock() } },
    }),
  );

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    openChannel,
    printError: () => {},
  });

  await connection.openWatchChannel(null);

  expect(openChannel).toHaveBeenCalledExactlyOnceWith('laptop');
});

test('it forwards the output of a session the live-terminal viewer can read', async () => {
  const watched: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: {
      session: {
        get: mock(() =>
          Promise.resolve({
            session: buildMockSessionDescriptor({ name: 'on-local' }),
            prompt: null,
            lastActivityAt: 0,
            pending: null,
            result: null,
            sessionRecord: null,
          }),
        ),
        watch: mock(),
      },
    },
  };

  const reach: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get: mock(), watch: mock() } },
  };

  const channels = new Map([
    ['laptop', watched],
    ['web-panel', reach],
  ]);

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: (principal) => {
      const channel = channels.get(principal);

      invariant(channel, `no stand-in channel for ${principal}`);

      return Promise.resolve(channel);
    },
  });

  const channel = await connection.openWatchChannel('web-panel');

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  watched.onEvent({ ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'hello' });

  await waitFor(() => {
    expect(events).toStrictEqual([
      { ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'hello' },
    ]);
  });
});

test('it drops the output of a session the live-terminal viewer cannot read while its removal is held back', async () => {
  const watched: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: {
      session: {
        get: mock(() =>
          Promise.reject(new DaemonError('no_such_session', "no session 'on-spare'")),
        ),
        watch: mock(),
      },
    },
  };

  // The viewer's own connection never reports the removal.
  const reach: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get: mock(), watch: mock() } },
  };

  const channels = new Map([
    ['laptop', watched],
    ['web-panel', reach],
  ]);

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: (principal) => {
      const channel = channels.get(principal);

      invariant(channel, `no stand-in channel for ${principal}`);

      return Promise.resolve(channel);
    },
  });

  const channel = await connection.openWatchChannel('web-panel');

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  watched.onEvent({ ev: 'SessionOutput', sessionID: 'on-spare', seq: 1, data: 'secret' });
  watched.onEvent({ ev: 'SessionOutput', sessionID: 'on-spare', seq: 2, data: 'more' });

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionRemoved', sessionID: 'on-spare' }]);
  });
});

test('it ends a live terminal and reports the failure when a read of its session fails for another reason', async () => {
  const watched: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: {
      session: {
        get: mock(() => Promise.reject(new DaemonError('internal', 'the outbound queue is full'))),
        watch: mock(),
      },
    },
  };

  const reach: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get: mock(), watch: mock() } },
  };

  const channels = new Map([
    ['laptop', watched],
    ['web-panel', reach],
  ]);

  const printError = mock<(line: string) => void>();

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError,
    openChannel: (principal) => {
      const channel = channels.get(principal);

      invariant(channel, `no stand-in channel for ${principal}`);

      return Promise.resolve(channel);
    },
  });

  const channel = await connection.openWatchChannel('web-panel');

  const events: DaemonEvent[] = [];
  const onClose = mock<() => void>();

  channel.onEvent = (event) => {
    events.push(event);
  };

  channel.onClose = onClose;

  watched.onEvent({ ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'hello' });

  await waitFor(() => {
    expect(onClose).toHaveBeenCalledOnce();
  });

  expect(events).toStrictEqual([]);

  expect(printError).toHaveBeenCalledExactlyOnceWith(
    "atc mcp --http: daemon 'box' could not read session 'on-local' as 'web-panel' for a live terminal, which ended: the outbound queue is full",
  );
});

test('it reports no failure for a read that a live terminal ends while it waits', async () => {
  const read = Promise.withResolvers<never>();
  const get = mock(() => read.promise);

  const watched: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get, watch: mock() } },
  };

  const reach: NamedDaemonChannel = {
    onClose: () => {},
    onEvent: () => {},
    principal: undefined,
    sendHello: () => Promise.resolve({}),
    sendRequest: () => Promise.resolve({}),
    stop: () => {},
    procedures: { session: { get: mock(), watch: mock() } },
  };

  const channels = new Map([
    ['laptop', watched],
    ['web-panel', reach],
  ]);

  const printError = mock<(line: string) => void>();

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError,
    openChannel: (principal) => {
      const channel = channels.get(principal);

      invariant(channel, `no stand-in channel for ${principal}`);

      return Promise.resolve(channel);
    },
  });

  const channel = await connection.openWatchChannel('web-panel');

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  watched.onEvent({ ev: 'SessionOutput', sessionID: 'on-local', seq: 1, data: 'hello' });

  await waitFor(() => {
    expect(get).toHaveBeenCalledOnce();
  });

  channel.stop();
  read.reject(new Error('client closed'));

  // The rejected read resumes the forwarder in microtasks only, so one
  // macrotask turn runs it to its end.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(events).toStrictEqual([]);
  expect(printError).not.toHaveBeenCalled();
});

test("it lists for a connector's tool request only the sessions the connector may read", async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-local',
    cols: 80,
    rows: 24,
  });

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const named = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: remote.daemon.listenPort,
    token: { kind: 'file', path: ctx.tokenFile },
    principal: 'laptop',
  });

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: makeRemoteChannelOpener(named, (daemon) =>
      bootRemoteDaemonClient(daemon, 'atc/test-client'),
    ),
  });

  onTestFinished(() => connection.caller.stop());

  const listed = await connection.caller.sendRequest('session.list', undefined, {
    id: 'web-panel',
    name: 'Web panel',
  });

  expect(listed['sessions']).toStrictEqual([expect.objectContaining({ name: 'on-local' })]);
});

test("it hides a session outside the entry principal's targets from a live-terminal viewer that reaches it", async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([
          ['laptop', ['elsewhere']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'local-only',
    cols: 80,
    rows: 24,
  });

  const named = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: remote.daemon.listenPort,
    token: { kind: 'file', path: ctx.tokenFile },
    principal: 'laptop',
  });

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: makeRemoteChannelOpener(named, (daemon) =>
      bootRemoteDaemonClient(daemon, 'atc/test-client'),
    ),
  });

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  expect(channel.procedures.session.get({ session: sessionID })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it gives a live-terminal channel the same reach over time as the tool requests of its viewer', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const parent = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'watched',
    cols: 80,
    rows: 24,
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const named = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: remote.daemon.listenPort,
    token: { kind: 'file', path: ctx.tokenFile },
    principal: 'laptop',
  });

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: makeRemoteChannelOpener(named, (daemon) =>
      bootRemoteDaemonClient(daemon, 'atc/test-client'),
    ),
  });

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'child-on-spare',
    target: 'spare',
    parent: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', sessionID: parentID });
  });
});

test('it refuses a live-terminal viewer a read of a session that only the entry principal may read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  const named = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: remote.daemon.listenPort,
    token: { kind: 'file', path: ctx.tokenFile },
    principal: 'laptop',
  });

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: makeRemoteChannelOpener(named, (daemon) =>
      bootRemoteDaemonClient(daemon, 'atc/test-client'),
    ),
  });

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  expect(channel.procedures.session.watch({ session: sessionID })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it forwards a live-terminal viewer no event of a session that only the entry principal may read', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildLocalTarget(),
          {
            id: 'spare',
            kind: 'local-pty',
            options: {},
            identity: 'test:spare',
            provider: createLocalPTYProvider(),
          },
        ],
        principals: new Map([
          ['laptop', ['local', 'spare']],
          ['web-panel', ['local']],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  invariant(remote.daemon.listenPort !== null, 'the remote daemon bound no TCP port');

  const named = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: remote.daemon.listenPort,
    token: { kind: 'file', path: ctx.tokenFile },
    principal: 'laptop',
  });

  const connection = createNamedDaemonConnection({
    name: 'box',
    principal: 'laptop',
    printError: () => {},
    openChannel: makeRemoteChannelOpener(named, (daemon) =>
      bootRemoteDaemonClient(daemon, 'atc/test-client'),
    ),
  });

  const channel = await connection.openWatchChannel('web-panel');

  onTestFinished(() => {
    channel.stop();
  });

  const events: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    events.push(event);
  };

  const spawned = await remote.client.sendRequest('session.spawn', {
    cwd: remote.directory,
    agent: 'claude',
    name: 'on-spare',
    target: 'spare',
    cols: 80,
    rows: 24,
  });

  const sessionID = String(getRecord(spawned, 'session')['id']);

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', sessionID });
  });

  expect(events).toStrictEqual([{ ev: 'SessionRemoved', sessionID }]);
});
