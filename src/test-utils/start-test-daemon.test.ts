import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import type { HookEvent } from '../protocol/hook-event';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';
import { buildMockFleetEntry } from './build-mock-fleet-entry';
import { startTestDaemon } from './start-test-daemon';
import { waitFor } from './wait-for';

test('it answers a request on the main client without another handshake', async () => {
  await using harness = await startTestDaemon();

  const listed = await harness.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it keeps every socket and state path inside its directory', async () => {
  await using harness = await startTestDaemon({ prefix: 'atc-paths-' });

  expect([
    harness.socketPath,
    harness.reporterSocketPath,
    harness.eventsSocketPath,
    harness.dbPath,
    harness.statusPath,
  ]).toStrictEqual([
    join(harness.dir, 'daemon.sock'),
    join(harness.dir, 'reporter.sock'),
    join(harness.dir, 'events.sock'),
    join(harness.dir, 'state.db'),
    join(harness.dir, 'status.json'),
  ]);
});

test('it names the directory by the prefix', async () => {
  await using harness = await startTestDaemon({ prefix: 'atc-named-' });

  expect(harness.dir).toInclude('/atc-named-');
});

test('it hands the options builder the daemon paths', async () => {
  const seen: unknown[] = [];

  await using harness = await startTestDaemon({
    options: (paths) => {
      seen.push(paths);

      return {};
    },
  });

  expect(seen).toStrictEqual([
    {
      dir: harness.dir,
      socketPath: harness.socketPath,
      reporterSocketPath: harness.reporterSocketPath,
      eventsSocketPath: harness.eventsSocketPath,
      dbPath: harness.dbPath,
      statusPath: harness.statusPath,
    },
  ]);
});

test('it boots the daemon with the adapters the options give', async () => {
  await using harness = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      adapters: [buildMockAgentAdapter({ id: 'grok' })],
    }),
  });

  const listed = await harness.client.sendRequest('agents.list');

  expect(listed['agents']).toIncludeAllPartialMembers([{ id: 'claude' }, { id: 'grok' }]);
});

test('it serves a TCP handshake on the listener the options ask for', async () => {
  await using harness = await startTestDaemon({
    options: (paths) => {
      const tokenFile = join(paths.dir, 'tokens');

      writeFileSync(tokenFile, 'a-gateway-token-of-at-least-32-bytes\n');

      return { listen: { host: '127.0.0.1', port: 0, tokenFile } };
    },
  });

  const client = await harness.openTCPClient();

  expect(
    client.sendHello('atc/test-gateway', 'a-gateway-token-of-at-least-32-bytes'),
  ).resolves.toContainKey('daemonID');
});

test('it refuses a TCP client when the daemon has no listener', async () => {
  await using harness = await startTestDaemon();

  expect(harness.openTCPClient()).rejects.toThrowWithMessage(
    Error,
    'the test daemon started without a TCP listener',
  );
});

test('it collects the daemon log lines', async () => {
  await using harness = await startTestDaemon({
    options: (paths) => {
      const tokenFile = join(paths.dir, 'tokens');

      writeFileSync(tokenFile, 'a-gateway-token-of-at-least-32-bytes\n');

      return { listen: { host: '127.0.0.1', port: 0, tokenFile } };
    },
  });

  const port = harness.daemon.listenPort;

  invariant(port !== null, 'the daemon started without a TCP listener');

  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        socket.end('not a handshake\n');
      },
      close() {
        closed.resolve();
      },
      data() {},
      error() {},
    },
  });

  await closed.promise;

  await waitFor(() => {
    expect(harness.logs).toPartiallyContain(expect.stringContaining('atc tcp'));
  });
});

test('it leaves the log to the options when they set one', async () => {
  const lines: string[] = [];

  await using harness = await startTestDaemon({
    options: (paths) => {
      const tokenFile = join(paths.dir, 'tokens');

      writeFileSync(tokenFile, 'a-gateway-token-of-at-least-32-bytes\n');

      return {
        listen: { host: '127.0.0.1', port: 0, tokenFile },
        log: (line) => {
          lines.push(line);
        },
      };
    },
  });

  const port = harness.daemon.listenPort;

  invariant(port !== null, 'the daemon started without a TCP listener');

  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(socket) {
        socket.end('not a handshake\n');
      },
      close() {
        closed.resolve();
      },
      data() {},
      error() {},
    },
  });

  await closed.promise;

  await waitFor(() => {
    expect(lines).not.toBeEmpty();
  });

  expect(harness.logs).toBeEmpty();
});

test('it collects the events the main client receives', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  await harness.client.sendRequest('session.spawn', { cwd: harness.dir, name: 'alpha' });

  await waitFor(() => {
    expect(harness.events).toPartiallyContain({ ev: 'SessionAdded' });
  });
});

test('it counts each client it opens on the daemon', async () => {
  await using harness = await startTestDaemon();

  await harness.openClient();

  expect(harness.daemon.countClients()).toBe(2);
});

test('it sends the handshake params a client opens with', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ principals: new Map([['ops', ['local']]]) }),
  });

  const client = await harness.openClient({ principal: 'ops' });

  expect(client.sendRequest('daemon.quit')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "daemon.quit is open to the daemon's owner only",
  });
});

test('it delivers hook lines to the session they report on', async () => {
  const seen: HookEvent[] = [];

  await using harness = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        normalizeHook: (event) => {
          seen.push(event);

          return { kind: 'heartbeat' };
        },
      }),
    }),
  });

  const spawned = await harness.client.sendRequest('session.spawn', {
    cwd: harness.dir,
    name: 'alpha',
  });

  const session = spawned['session'];

  invariant(
    typeof session === 'object' && session !== null && 'id' in session,
    'the spawn returned no session',
  );

  await harness.sendHookLines({ atcId: session.id, event: 'Notification', payload: {} });

  await waitFor(() => {
    expect(seen).toPartiallyContain({ atcId: session.id, event: 'Notification' });
  });
});

test('it delivers every hook line of a large batch', async () => {
  const seen: HookEvent[] = [];

  await using harness = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        normalizeHook: (event) => {
          seen.push(event);

          return { kind: 'heartbeat' };
        },
      }),
    }),
  });

  const spawned = await harness.client.sendRequest('session.spawn', {
    cwd: harness.dir,
    name: 'alpha',
  });

  const session = spawned['session'];

  invariant(
    typeof session === 'object' && session !== null && 'id' in session,
    'the spawn returned no session',
  );

  // 64 lines of 32 KiB each hold more than a socket buffer takes at once.
  const padding = 'x'.repeat(32 * 1024);

  await harness.sendHookLines(
    ...Array.from({ length: 64 }, (_, index) => ({
      atcId: session.id,
      event: 'Notification',
      payload: { index, padding },
    })),
  );

  await waitFor(() => {
    expect(seen).toHaveLength(64);
  });
});

test('it closes every client the daemon holds when it stops', async () => {
  await using harness = await startTestDaemon();

  const outside = await DaemonClient.open(harness.socketPath);

  onTestFinished(() => {
    outside.stop();
  });

  const closed = Promise.withResolvers<void>();

  outside.onClose = () => {
    closed.resolve();
  };

  await harness.stop();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it boots a new daemon with a new main client on restart', async () => {
  await using harness = await startTestDaemon();

  const before = { daemon: harness.daemon, client: harness.client };

  await harness.restart();

  const listed = await harness.client.sendRequest('session.list');

  expect(harness.daemon).not.toBe(before.daemon);
  expect(harness.client).not.toBe(before.client);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it closes the clients of the replaced daemon on restart', async () => {
  await using harness = await startTestDaemon();

  await harness.openClient();
  await harness.restart();

  expect(harness.daemon.countClients()).toBe(1);
});

test('it keeps the stored fleet across a restart', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const spawned = await harness.client.sendRequest('session.spawn', {
    cwd: harness.dir,
    name: 'alpha',
  });

  const session = spawned['session'];

  invariant(
    typeof session === 'object' && session !== null && 'id' in session,
    'the spawn returned no session',
  );

  await harness.client.sendRequest('session.kill', { session: session.id });
  await harness.restart();
  await harness.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await harness.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({ name: 'alpha' });
});

test('it boots on the state written while the daemon is stopped', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  await harness.stop();

  const store = await StateStore.open(harness.dbPath);

  onTestFinished(() => store.stop());

  await store.writeFleet([buildMockFleetEntry({ name: 'seeded', exited: true })]);
  await harness.restart();
  await harness.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await harness.client.sendRequest('session.list');

  expect(listed['sessions']).toPartiallyContain({ name: 'seeded' });
});

test('it boots with the options a restart gives', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  await harness.restart(() => ({
    adapter: buildMockAgentAdapter(),
    adapters: [buildMockAgentAdapter({ id: 'grok' })],
  }));

  const listed = await harness.client.sendRequest('agents.list');

  expect(listed['agents']).toPartiallyContain({ id: 'grok' });
});

test('it stops the running daemon and removes its directory on dispose', async () => {
  const harness = await startTestDaemon();

  onTestFinished(() => harness[Symbol.asyncDispose]());

  const outside = await DaemonClient.open(harness.socketPath);

  onTestFinished(() => {
    outside.stop();
  });

  const closed = Promise.withResolvers<void>();

  outside.onClose = () => {
    closed.resolve();
  };

  await harness[Symbol.asyncDispose]();

  expect(closed.promise).resolves.toBeUndefined();
  expect(existsSync(harness.dir)).toBeFalse();
});

test('it stops the daemon a restart booted on dispose', async () => {
  const harness = await startTestDaemon();

  onTestFinished(() => harness[Symbol.asyncDispose]());

  await harness.restart();

  const outside = await DaemonClient.open(harness.socketPath);

  onTestFinished(() => {
    outside.stop();
  });

  const closed = Promise.withResolvers<void>();

  outside.onClose = () => {
    closed.resolve();
  };

  await harness[Symbol.asyncDispose]();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it removes its directory when the daemon fails to boot', () => {
  const dirs: string[] = [];

  expect(
    startTestDaemon({
      options: (paths) => {
        dirs.push(paths.dir);

        return { listen: { host: '8.8.8.8', port: 0, tokenFile: join(paths.dir, 'tokens') } };
      },
    }),
  ).rejects.toMatchObject({ code: 'listen_refused' });

  expect(dirs).toSatisfyAll((dir: string) => !existsSync(dir));
  expect(dirs).toHaveLength(1);
});

test('it stops the daemon and removes its directory once the test finishes without a dispose', async () => {
  const harness = await startTestDaemon();

  onTestFinished(() => {
    expect(existsSync(harness.dir)).toBeFalse();
  });
});

test('it stops once when disposed before the test finishes', async () => {
  const harness = await startTestDaemon();

  await harness[Symbol.asyncDispose]();

  expect(existsSync(harness.dir)).toBeFalse();
});
