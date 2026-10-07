import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { EventMsg } from '../protocol/protocol';
import { claimDaemonLock } from '../shared/claim-daemon-lock';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { canBindAddresses } from '../test-utils/can-bind-addresses';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

test('it answers a TCP handshake that carries a token from the token file', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();
  const hello = await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(hello).toMatchObject({
    daemon: 'atc/test-build',
    features: expect.toIncludeAllMembers(['transport.tcp']),
    idempotency: { completedRetentionMs: 86_400_000 },
  });
});

test('it refuses a TCP handshake without a token and closes the connection', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  const hello = client.sendHello('atc/test-gateway');

  expect(hello).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it refuses a TCP handshake with a wrong token and closes the connection', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  const hello = client.sendHello('atc/test-gateway', 'b'.repeat(40));

  expect(hello).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it closes a TCP connection that sends a request before the handshake without answering it', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  expect(client.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test.each([
  ['the first', 'a'.repeat(32)],
  ['the second', 'b'.repeat(40)],
])('it accepts a handshake with %s token of a two-token file', async (_which, token) => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n${'b'.repeat(40)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();
  const hello = await client.sendHello('atc/test-gateway', token);

  expect(hello).toContainKey('daemonID');
});

test('it serves a TCP request that acts as a listed principal', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  const listed = await client.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });
});

test('it refuses a TCP request without as', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.list', {})).rejects.toMatchObject({
    code: 'unauthorized',
  });
});

test.each([['daemon.quit'], ['fleet.restore']])(
  'it refuses %s over TCP as owner-only',
  async (method) => {
    await using daemon = await startTestDaemon({
      options: (paths) => {
        writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

        return {
          adapter: buildMockAgentAdapter(),
          principals: new Map([['gw', ['local']]]),
          listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        };
      },
    });

    const client = await daemon.openTCPClient();

    await client.sendHello('atc/test-gateway', 'a'.repeat(32));

    expect(client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
      code: 'unauthorized',
      message: `${method} is open to the daemon's owner only`,
    });
  },
);

test.each([['daemon.quit'], ['fleet.restore']])(
  'it keeps serving the owner after it refuses %s over TCP',
  async (method) => {
    await using daemon = await startTestDaemon({
      options: (paths) => {
        writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

        return {
          adapter: buildMockAgentAdapter(),
          principals: new Map([['gw', ['local']]]),
          listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        };
      },
    });

    const client = await daemon.openTCPClient();

    await client.sendHello('atc/test-gateway', 'a'.repeat(32));
    await Promise.allSettled([client.sendRequest(method, {}, 'gw')]);

    const pinged = await daemon.client.sendRequest('daemon.ping', {});

    expect(pinged).toStrictEqual({});
  },
);

test('it refuses a TCP request as a principal the principals key does not list', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.list', {}, 'other')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "principal 'other' is not listed in principals",
  });
});

test('it refuses every TCP principal when the config has no principals key', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: null,
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, resume: 'a-1' });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "principal 'gw' is not listed in principals",
  });
});

test('it refuses a TCP handshake whose principal the principals key does not list', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  const hello = client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'other',
    auth: { scheme: 'bearer', token: 'a'.repeat(32) },
  });

  expect(hello).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it lists none of the sessions outside the targets of a TCP principal', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', []]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, resume: 'a-1' });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  const listed = await client.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it answers a TCP principal reading a session outside its targets as for a missing session', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', []]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.get', { session: id }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: `no session '${id}'`,
  });
});

test('it answers a TCP principal killing a session outside its targets as for a missing session', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', []]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.kill', { session: id }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: `no session '${id}'`,
  });
});

test('it keeps a session that a TCP principal outside its targets tried to kill', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', []]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));
  await Promise.allSettled([client.sendRequest('session.kill', { session: id }, 'gw')]);

  const listed = await daemon.client.sendRequest('session.list', {});

  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: true })] });
});

test('it lists for a TCP principal only the sessions on the targets it may use', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      // The targets `local` and `box` share one real pseudo-terminal provider.
      const local = new LocalPTYProvider();

      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        targets: targets.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider: local,
        })),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
      };
    },
  });

  const onLocal = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
    target: 'local',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-2',
    target: 'box',
  });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  const listed = await client.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(onLocal, 'session')['id'] })],
  });
});

test('it reads for a TCP principal a session on a target it may use', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      // The targets `local` and `box` share one real pseudo-terminal provider.
      const local = new LocalPTYProvider();

      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        targets: targets.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider: local,
        })),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
    target: 'local',
  });

  const id = getRecord(spawned, 'session')['id'];

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  const got = await client.sendRequest('session.get', { session: id }, 'gw');

  expect(got).toMatchObject({ session: { id } });
});

test('it answers a TCP principal reading a session on a target it may not use as for a missing session', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      // The targets `local` and `box` share one real pseudo-terminal provider.
      const local = new LocalPTYProvider();

      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        targets: targets.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider: local,
        })),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(client.sendRequest('session.get', { session: id }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: `no session '${id}'`,
  });
});

test('it pushes a TCP connection no event of a session it did not act on', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  const pushed: EventMsg[] = [];

  client.onEvent = (event) => {
    pushed.push(event);
  };

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));
  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, resume: 'a-1' });

  // The owner's event shows the daemon has broadcast the spawn.
  await waitFor(() => {
    expect(daemon.events).toPartiallyContain({ ev: 'SessionAdded' });
  });

  await client.sendRequest('session.list', {}, 'gw');

  expect(pushed).toStrictEqual([]);
});

test('it closes a TCP connection whose token a reload removes', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n${'b'.repeat(40)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const removed = await daemon.openTCPClient();

  const closed = Promise.withResolvers<'closed'>();

  removed.onClose = () => {
    closed.resolve('closed');
  };

  await removed.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'b'.repeat(40)}\n`);

  daemon.daemon.refreshTokens();

  const ended = await closed.promise;

  expect(ended).toBe('closed');
});

test('it keeps serving a TCP connection whose token a reload keeps', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n${'b'.repeat(40)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const kept = await daemon.openTCPClient();

  await kept.sendHello('atc/test-gateway', 'b'.repeat(40));

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'b'.repeat(40)}\n`);

  daemon.daemon.refreshTokens();

  const listed = await kept.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a handshake with a token a reload removed', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'b'.repeat(40)}\n`);

  daemon.daemon.refreshTokens();

  const client = await daemon.openTCPClient();

  expect(client.sendHello('atc/test-gateway', 'a'.repeat(32))).rejects.toMatchObject({
    code: 'unauthorized',
  });
});

test('it closes every TCP connection after an invalid reload', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const open = await daemon.openTCPClient();

  const closed = Promise.withResolvers<'closed'>();

  open.onClose = () => {
    closed.resolve('closed');
  };

  await open.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'a'.repeat(32)}\nshort\n`);

  daemon.daemon.refreshTokens();

  const ended = await closed.promise;

  expect(ended).toBe('closed');
});

test('it refuses every handshake after an invalid reload and logs the failed reload', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'a'.repeat(32)}\nshort\n`);

  daemon.daemon.refreshTokens();

  const client = await daemon.openTCPClient();

  expect(client.sendHello('atc/test-gateway', 'a'.repeat(32))).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(daemon.logs).toStrictEqual([
    expect.toStartWith('atc tcp event=listening '),
    expect.toInclude('token reload failed'),
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it takes handshakes again after a valid reload follows an invalid one', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  writeFileSync(join(daemon.dir, 'gateway-token'), '');

  daemon.daemon.refreshTokens();

  writeFileSync(join(daemon.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  daemon.daemon.refreshTokens();

  const client = await daemon.openTCPClient();
  const hello = await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect(hello).toContainKey('daemonID');
});

test('it delays the next handshake from an address by the failure delay after five failures within a minute', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 600,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const client = await daemon.openTCPClient();

  const hello = Promise.allSettled([client.sendHello('atc/test-gateway', 'a'.repeat(32))]);

  onTestFinished(() => hello);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([600]);
  });
});

test('it answers a delayed handshake once the failure delay passes', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 600,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const client = await daemon.openTCPClient();

  const hello = client.sendHello('atc/test-gateway', 'a'.repeat(32));

  // The listener has begun the delay once it schedules its timer.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([600]);
  });

  clock.advance(600);

  const answered = await hello;

  expect(answered).toContainKey('daemonID');
});

test('it answers the handshake at once before an address has failed five times', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 600,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 4 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const client = await daemon.openTCPClient();
  const hello = await client.sendHello('atc/test-gateway', 'a'.repeat(32));

  expect<Record<string, unknown>>({ hello, pending: clock.collectPending() }).toStrictEqual({
    hello: expect.objectContaining({ daemonID: expect.toBeString() }),
    pending: [],
  });
});

test('it refuses to start a listener on an address outside the allowed ranges', () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  expect(
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '0.0.0.0', port: 0, tokenFile: join(tmp.dir, 'gateway-token') },
    }),
  ).rejects.toMatchObject({ code: 'listen_refused' });
});

test('it refuses to start a listener whose token file holds a short token', () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  writeFileSync(join(tmp.dir, 'gateway-token'), 'short\n');

  expect(
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'gateway-token') },
    }),
  ).rejects.toMatchObject({ code: 'listen_refused' });
});

test('it logs the address and port the TCP listener bound', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  expect(daemon.logs).toStrictEqual([
    `atc tcp event=listening host=127.0.0.1 port=${String(daemon.daemon.listenPort)}`,
  ]);
});

test('it logs no listener start when the TCP listener cannot bind', async () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  const logged: string[] = [];

  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  await Promise.allSettled([
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '127.0.0.1', port: held.port, tokenFile: join(tmp.dir, 'gateway-token') },
      log: (line) => {
        logged.push(line);
      },
    }),
  ]);

  expect(logged).toStrictEqual([]);
});

test('it logs a refused handshake with the peer and the reason', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([client.sendHello('atc/test-gateway', 'b'.repeat(40))]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs no part of the token a refused handshake presents', async () => {
  const presented = randomBytes(24).toString('hex');

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([client.sendHello('atc/test-gateway', presented)]);

  expect(
    Array.from({ length: presented.length - 7 }, (_, at) => presented.slice(at, at + 8)),
  ).toSatisfyAll((part: string) => !daemon.logs.join('\n').includes(part));
});

test('it logs a refused principal as unlisted with the peer', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'other',
      auth: { scheme: 'bearer', token: 'a'.repeat(32) },
    }),
  ]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=principal_refused peer=127.0.0.1 principal=unlisted count=1',
  ]);
});

test('it logs a principal refused on a request after the handshake', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await client.sendHello('atc/test-gateway', 'a'.repeat(32));
  await Promise.allSettled([client.sendRequest('session.list', {}, 'other')]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=principal_refused peer=127.0.0.1 principal=unlisted count=1',
  ]);
});

test('it logs a token sent in pieces as a refused principal as unlisted', async () => {
  const token = randomBytes(24).toString('hex');

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${token}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: Array.from({ length: 7 }, (_, at) => token.slice(at * 7, at * 7 + 7)).join('.'),
      auth: { scheme: 'bearer', token },
    }),
  ]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=principal_refused peer=127.0.0.1 principal=unlisted count=1',
  ]);
});

test('it logs no part of a token sent in pieces as a refused principal', async () => {
  const token = randomBytes(24).toString('hex');

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${token}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: Array.from({ length: 7 }, (_, at) => token.slice(at * 7, at * 7 + 7)).join('.'),
      auth: { scheme: 'bearer', token },
    }),
  ]);

  expect(Array.from({ length: token.length - 3 }, (_, at) => token.slice(at, at + 4))).toSatisfyAll(
    (part: string) => !daemon.logs.slice(1).join('\n').includes(part),
  );
});

test('it logs no principal line for a listed principal', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw',
    auth: { scheme: 'bearer', token: 'a'.repeat(32) },
  });

  expect(daemon.logs.slice(1)).toStrictEqual([]);
});

test('it logs no control character of a refused principal', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const client = await daemon.openTCPClient();

  await Promise.allSettled([
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'ops\u001B[2J\r\natc tcp event=listening\u009B',
      auth: { scheme: 'bearer', token: 'a'.repeat(32) },
    }),
  ]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=principal_refused peer=127.0.0.1 principal=unlisted count=1',
  ]);
});

test('it folds repeated refusals from one peer within the window into one line', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          refusalLogIntervalMs: 60_000,
        },
      };
    },
  });

  const refused = await Promise.all(Array.from({ length: 3 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    refused.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  clock.advance(59_999);

  const client = await daemon.openTCPClient();

  await Promise.allSettled([client.sendHello('atc/test-gateway', 'b'.repeat(40))]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs a refusal after the window as a new line after the count of the folded ones', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          refusalLogIntervalMs: 60_000,
        },
      };
    },
  });

  const refused = await Promise.all(Array.from({ length: 3 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    refused.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  clock.advance(60_000);

  const client = await daemon.openTCPClient();

  await Promise.allSettled([client.sendHello('atc/test-gateway', 'b'.repeat(40))]);

  expect(daemon.logs.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=2',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

// These peers dial from loopback aliases past 127.0.0.1, which Linux routes
// on its own and stock macOS lacks, so a host without them skips the test.
// The refusal log's unit tests cover the same windows with any peer.
test.skipIf(!canBindAddresses(['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5']))(
  'it logs a line for each new peer while the cap of refusal windows has room',
  async () => {
    await using daemon = await startTestDaemon({
      options: (paths) => {
        writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

        return {
          adapter: buildMockAgentAdapter(),
          principals: new Map(),
          listen: {
            host: '127.0.0.1',
            port: 0,
            tokenFile: join(paths.dir, 'gateway-token'),
            maxRefusalWindows: 4,
          },
        };
      },
    });

    for (const localAddress of [
      '127.0.0.2',
      '127.0.0.3',
      '127.0.0.4',
      '127.0.0.5',
      '127.0.0.2',
      '127.0.0.3',
    ]) {
      const closed = Promise.withResolvers<void>();

      createConnection({ host: '127.0.0.1', port: daemon.daemon.listenPort ?? 0, localAddress })
        .on('error', closed.reject)
        .on('close', () => {
          closed.resolve();
        })
        .end('not a handshake\n');

      await closed.promise;
    }

    expect(daemon.logs.slice(1)).toStrictEqual([
      'atc tcp event=handshake_refused peer=127.0.0.2 reason=unexpected_line count=1',
      'atc tcp event=handshake_refused peer=127.0.0.3 reason=unexpected_line count=1',
      'atc tcp event=handshake_refused peer=127.0.0.4 reason=unexpected_line count=1',
      'atc tcp event=handshake_refused peer=127.0.0.5 reason=unexpected_line count=1',
    ]);
  },
);

// These peers dial from loopback aliases past 127.0.0.1, which Linux routes
// on its own and stock macOS lacks, so a host without them skips the test.
// The refusal log's unit tests cover the same windows with any peer.
test.skipIf(!canBindAddresses(['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5']))(
  'it folds refusals from peers past the cap of refusal windows into one overflow line',
  async () => {
    await using daemon = await startTestDaemon({
      options: (paths) => {
        writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

        return {
          adapter: buildMockAgentAdapter(),
          principals: new Map(),
          listen: {
            host: '127.0.0.1',
            port: 0,
            tokenFile: join(paths.dir, 'gateway-token'),
            maxRefusalWindows: 2,
          },
        };
      },
    });

    for (const localAddress of Array.from({ length: 4 }, () => [
      '127.0.0.2',
      '127.0.0.3',
      '127.0.0.4',
      '127.0.0.5',
    ]).flat()) {
      const closed = Promise.withResolvers<void>();

      createConnection({ host: '127.0.0.1', port: daemon.daemon.listenPort ?? 0, localAddress })
        .on('error', closed.reject)
        .on('close', () => {
          closed.resolve();
        })
        .end('not a handshake\n');

      await closed.promise;
    }

    expect(daemon.logs.slice(1)).toStrictEqual([
      'atc tcp event=handshake_refused peer=127.0.0.2 reason=unexpected_line count=1',
      'atc tcp event=handshake_refused peer=127.0.0.3 reason=unexpected_line count=1',
      'atc tcp event=refused peer=overflow count=1',
    ]);
  },
);

test('it refuses a listener whose port another socket holds', () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  expect(
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '127.0.0.1', port: held.port, tokenFile: join(tmp.dir, 'gateway-token') },
    }),
  ).rejects.toMatchObject({
    code: 'listen_refused',
    message: `atc daemon: --listen cannot bind 127.0.0.1:${held.port} (EADDRINUSE)`,
  });
});

test('it releases the daemon lock and leaves no socket or record behind when the listener cannot bind', async () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(join(tmp.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

  await Promise.allSettled([
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: buildMockAgentAdapter(),
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '127.0.0.1', port: held.port, tokenFile: join(tmp.dir, 'gateway-token') },
    }),
  ]);

  const lock = await claimDaemonLock(join(tmp.dir, 'daemon.lock'), 0);

  onTestFinished(() => {
    lock?.dispose();
  });

  expect<Record<string, unknown>>({
    lock,
    socket: existsSync(join(tmp.dir, 'daemon.sock')),
    record: existsSync(join(tmp.dir, 'daemon.json')),
  }).toStrictEqual({ lock: expect.anything(), socket: false, record: false });
});

test('it closes an unauthenticated TCP connection that sends a malformed line without a reply', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const closed = Promise.withResolvers<void>();
  const received: string[] = [];

  await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.daemon.listenPort ?? 0,
    socket: {
      open(socket) {
        socket.write('{}\n');
      },
      data(_socket, buf) {
        received.push(buf.toString());
      },
      close() {
        closed.resolve();
      },
      error() {},
    },
  });

  await closed.promise;

  expect(received).toStrictEqual([]);
});

test('it counts lines before the handshake as failed handshakes toward the delay', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 600,
        },
      };
    },
  });

  for (const line of [
    '{}',
    'nope',
    '{"v":4,"id":1,"m":"session.list"}',
    '{"v":4,"ev":"X"}',
    '{}',
  ]) {
    const closed = Promise.withResolvers<void>();

    await Bun.connect({
      hostname: '127.0.0.1',
      port: daemon.daemon.listenPort ?? 0,
      socket: {
        open(socket) {
          socket.write(`${line}\n`);
        },
        data() {},
        close() {
          closed.resolve();
        },
        error() {},
      },
    });

    await closed.promise;
  }

  const client = await daemon.openTCPClient();

  const hello = Promise.allSettled([client.sendHello('atc/test-gateway', 'a'.repeat(32))]);

  onTestFinished(() => hello);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([600]);
  });
});

test('it refuses a second handshake on a TCP connection and closes it', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([
          ['gw-a', ['local']],
          ['gw-b', []],
        ]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const client = await daemon.openTCPClient();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  await client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw-a',
    auth: { scheme: 'bearer', token: 'a'.repeat(32) },
  });

  await client.sendRequest(
    'session.attach',
    { session: getRecord(spawned, 'session')['id'] },
    'gw-a',
  );

  const second = client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw-b',
    auth: { scheme: 'bearer', token: 'a'.repeat(32) },
  });

  expect(second).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it answers a local ping while a TCP peer floods handshakes past the failure limit', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 1500,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const hello = `${JSON.stringify({ v: 4, id: 1, m: 'daemon.hello', p: { auth: { scheme: 'bearer', token: 'b'.repeat(40) } } })}\n`;
  const flooded = Promise.withResolvers<'closed'>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.daemon.listenPort ?? 0,
    socket: {
      open(socket) {
        socket.write(hello.repeat(100_000));
      },
      data() {},
      close() {
        flooded.resolve('closed');
      },
      error() {},
    },
  });

  const pinged = await Promise.all([daemon.client.sendRequest('daemon.ping', {}), flooded.promise]);

  expect(pinged).toStrictEqual([{}, 'closed']);
});

test('it refuses at once a handshake that would wait while the cap of delayed handshakes is full', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 1500,
          maxDelayedHandshakes: 3,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const waiting = await Promise.all(Array.from({ length: 3 }, () => daemon.openTCPClient()));

  const held = Promise.allSettled(
    waiting.map((client) => client.sendHello('atc/test-gateway', 'a'.repeat(32))),
  );

  onTestFinished(() => held);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1500, 1500, 1500]);
  });

  const over = await daemon.openTCPClient();

  // The clock never moves, so only a refusal that waits on no delay settles.
  expect(over.sendHello('atc/test-gateway', 'a'.repeat(32))).rejects.toMatchObject({
    code: 'unauthorized',
  });
});

test('it answers the held handshakes once the delay passes after the cap refused another', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 1500,
          maxDelayedHandshakes: 3,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const waiting = await Promise.all(Array.from({ length: 3 }, () => daemon.openTCPClient()));

  const held = Promise.all(
    waiting.map((client) => client.sendHello('atc/test-gateway', 'a'.repeat(32))),
  );

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1500, 1500, 1500]);
  });

  const over = await daemon.openTCPClient();

  await Promise.allSettled([over.sendHello('atc/test-gateway', 'a'.repeat(32))]);

  clock.advance(1500);

  const answers = await held;

  expect<readonly unknown[]>(answers).toStrictEqual([
    expect.objectContaining({ daemonID: expect.toBeString() }),
    expect.objectContaining({ daemonID: expect.toBeString() }),
    expect.objectContaining({ daemonID: expect.toBeString() }),
  ]);
});

test('it ends a delayed handshake once its socket closes and frees its place in the cap', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 1500,
          maxDelayedHandshakes: 2,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const abandoned = await Promise.all(Array.from({ length: 2 }, () => daemon.openTCPClient()));

  const abandonedHellos = Promise.allSettled(
    abandoned.map((client) => client.sendHello('atc/test-gateway', 'a'.repeat(32))),
  );

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1500, 1500]);
  });

  for (const client of abandoned) {
    client.stop();
  }

  await abandonedHellos;

  // A closed socket cancels the timer of its delayed handshake.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([]);
  });

  const client = await daemon.openTCPClient();

  const hello = client.sendHello('atc/test-gateway', 'a'.repeat(32));

  // A full cap would refuse the handshake at once instead of delaying it.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([1500]);
  });

  clock.advance(1500);

  const answered = await hello;

  expect(answered).toContainKey('daemonID');
});

test('it answers a local ping while many TCP sockets each send a handshake during the delay', async () => {
  const clock = buildStubClock(0);

  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map(),
        clock,
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.dir, 'gateway-token'),
          failureDelayMs: 1500,
        },
      };
    },
  });

  const failing = await Promise.all(Array.from({ length: 5 }, () => daemon.openTCPClient()));

  await Promise.allSettled(
    failing.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  const flood = await Promise.all(Array.from({ length: 300 }, () => daemon.openTCPClient()));

  const floodHellos = Promise.allSettled(
    flood.map((client) => client.sendHello('atc/test-gateway', 'b'.repeat(40))),
  );

  onTestFinished(() => floodHellos);

  // The default cap holds 64 handshakes in the delay and refuses the rest.
  await waitFor(() => {
    expect(clock.collectPending()).toHaveLength(64);
  });

  const pinged = await daemon.client.sendRequest('daemon.ping', {});

  expect({ pinged, pending: clock.collectPending() }).toStrictEqual({
    pinged: {},
    pending: Array.from({ length: 64 }, () => 1500),
  });
});

test('it pushes a TCP connection whose handshake gives a principal the removal of a session that leaves its reach', async () => {
  await using daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.dir, 'gateway-token'), `${'a'.repeat(32)}\n`);

      // The targets `local` and `box` share one real pseudo-terminal provider.
      const local = new LocalPTYProvider();

      const targets = collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        undefined,
      );

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'gateway-token') },
        targets: targets.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider: local,
        })),
        defaultTarget: targets.defaultTarget,
        targetErrors: targets.errors,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
    target: 'local',
  });

  const parent = getRecord(spawned, 'session')['id'];

  const client = await daemon.openTCPClient();

  const pushed: EventMsg[] = [];

  client.onEvent = (event) => {
    pushed.push(event);
  };

  await client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw',
    auth: { scheme: 'bearer', token: 'a'.repeat(32) },
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    parent,
    resume: 'a-2',
  });

  await waitFor(() => {
    expect<readonly unknown[]>(
      pushed.filter((event) => event.ev === 'SessionRemoved'),
    ).toStrictEqual([expect.objectContaining({ s: parent })]);
  });
});
