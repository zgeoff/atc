import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { buildTargetIdentity } from './build-target-identity';
import { claimDaemonLock } from './claim-daemon-lock';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(40);

// The token file's starting content, the principals key (null for none),
// the failure delay the listener uses, and whether the daemon has a second
// target, `box`, beside `local`.
interface TCPDaemonOptions {
  readonly tokens: string;
  readonly box?: boolean;
  readonly principals: ReadonlyMap<string, readonly string[]> | null;
  readonly failureDelayMs?: number;
  readonly maxDelayedHandshakes?: number;
}

/**
 * A real daemon with a TCP listener on a kernel-chosen loopback port,
 * whose token file starts with the given content and whose principals key
 * is the given map, or absent when null. With `box`, the daemon runs the
 * targets `local` and `box`, each on a real pseudo-terminal, and
 * `spawnSession` takes the target. `owner` is the daemon owner's
 * connection on the local socket. `openTCP` dials the listener without a
 * handshake, and `openTCPAs` dials it and handshakes with a token.
 * `writeTokens` rewrites the token file. `logged` holds every line the
 * daemon logs, and `advanceClock` moves the clock the listener's refusal
 * log reads, whose window lasts a minute.
 */
async function setupTest(options: TCPDaemonOptions) {
  const tmp = setupTempDir('atc-daemon-tcp-');
  const tokenFile = join(tmp.dir, 'gateway-token');
  const logged: string[] = [];
  let clock = 0;

  writeFileSync(tokenFile, options.tokens);

  const local = new LocalPTYProvider();

  const targets = collectTargets(
    { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    undefined,
  );

  const daemon = await startDaemon({
    socketPath: join(tmp.dir, 'daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      screenDetector: null,
      takesMessages: true,
      headlessRunner: null,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'prompt-submitted' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => 'claude --resume',
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    principals: options.principals,
    ...(options.box === true
      ? {
          targets: targets.targets.map((target) => ({
            id: target.id,
            kind: target.provider,
            options: target.options,
            identity: buildTargetIdentity(target.provider, target.options),
            provider: local,
          })),
          defaultTarget: targets.defaultTarget,
          targetErrors: targets.errors,
        }
      : {}),
    listen: {
      host: '127.0.0.1',
      port: 0,
      tokenFile,
      ...(options.failureDelayMs === undefined ? {} : { failureDelayMs: options.failureDelayMs }),
      ...(options.maxDelayedHandshakes === undefined
        ? {}
        : { maxDelayedHandshakes: options.maxDelayedHandshakes }),
      now: () => clock,
      refusalLogIntervalMs: 60_000,
    },
    log: (line) => {
      logged.push(line);
    },
  });

  const clients: DaemonClient[] = [];

  const openTCP = async () => {
    const port = daemon.listenPort;

    if (port === null) {
      throw new Error('the daemon started without a TCP listener');
    }

    const client = await DaemonClient.open({ hostname: '127.0.0.1', port });

    clients.push(client);

    return client;
  };

  const owner = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

  clients.push(owner);

  await owner.sendHello('atc/test-build');

  return {
    daemon,
    owner,
    logged,
    openTCP,
    advanceClock(ms: number): void {
      clock += ms;
    },
    async openTCPAs(token: string): Promise<DaemonClient> {
      const client = await openTCP();

      await client.sendHello('atc/test-gateway', token);

      return client;
    },
    writeTokens(content: string): void {
      writeFileSync(tokenFile, content);
    },
    async spawnSession(target?: string): Promise<string> {
      const spawned = await owner.sendRequest('session.spawn', {
        cwd: '/tmp',
        resume: `a-${randomUUID()}`,
        ...(target === undefined ? {} : { target }),
      });

      return String(getRecord(spawned, 'session')['id']);
    },
    async [Symbol.asyncDispose]() {
      for (const client of clients) {
        client.stop();
      }

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it answers a TCP handshake that carries a token from the token file', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const client = await daemon.openTCP();
  const hello = await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(hello).toMatchObject({
    daemon: 'atc/test-build',
    features: expect.toIncludeAllMembers(['transport.tcp']),
    idempotency: { completedRetentionMs: 86_400_000 },
  });
});

test('it refuses a TCP handshake without a token and closes the connection', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const client = await daemon.openTCP();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  expect(client.sendHello('atc/test-gateway')).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it refuses a TCP handshake with a wrong token and closes the connection', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const client = await daemon.openTCP();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  expect(client.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  await closed.promise;
});

test('it closes a TCP connection that sends a request before the handshake without answering it', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const client = await daemon.openTCP();

  expect(client.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it accepts a handshake with either token of a two-token file', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n${TOKEN_B}\n`,
    principals: new Map(),
  });

  const first = await daemon.openTCP();
  const second = await daemon.openTCP();
  const firstHello = await first.sendHello('atc/test-gateway', TOKEN_A);
  const secondHello = await second.sendHello('atc/test-gateway', TOKEN_B);

  expect(firstHello).toContainKey('daemonID');
  expect(secondHello).toContainKey('daemonID');
});

test('it serves a TCP request that acts as a listed principal', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const id = await daemon.spawnSession();
  const client = await daemon.openTCPAs(TOKEN_A);
  const listed = await client.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id })] });
});

test('it refuses a TCP request without as', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCPAs(TOKEN_A);

  expect(client.sendRequest('session.list', {})).rejects.toMatchObject({
    code: 'unauthorized',
  });
});

test.each([['daemon.quit'], ['fleet.restore']])(
  'it refuses %s over TCP as owner-only',
  async (method) => {
    await using daemon = await setupTest({
      tokens: `${TOKEN_A}\n`,
      principals: new Map([['gw', ['local']]]),
    });

    const client = await daemon.openTCPAs(TOKEN_A);

    expect(client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
      code: 'unauthorized',
      message: `${method} is open to the daemon's owner only`,
    });

    const pinged = await daemon.owner.sendRequest('daemon.ping', {});

    expect(pinged).toStrictEqual({});
  },
);

test('it refuses a TCP request as a principal the principals key does not list', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCPAs(TOKEN_A);

  expect(client.sendRequest('session.list', {}, 'other')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "principal 'other' is not listed in principals",
  });
});

test('it refuses every TCP principal when the config has no principals key', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: null });

  await daemon.spawnSession();

  const client = await daemon.openTCPAs(TOKEN_A);

  expect(client.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "principal 'gw' is not listed in principals",
  });
});

test('it refuses a TCP handshake whose principal the principals key does not list', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCP();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  expect(
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'other',
      auth: { scheme: 'bearer', token: TOKEN_A },
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it answers a TCP principal for a session outside its targets as for a missing session', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', []]]),
  });

  const id = await daemon.spawnSession();
  const client = await daemon.openTCPAs(TOKEN_A);
  const listed = await client.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });

  expect(client.sendRequest('session.get', { session: id }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: `no session '${id}'`,
  });

  expect(client.sendRequest('session.kill', { session: id }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
  });

  const ownerList = await daemon.owner.sendRequest('session.list', {});

  expect(ownerList).toMatchObject({ sessions: [expect.objectContaining({ id })] });
});

test('it lists and reads for a TCP principal only the sessions on the targets it may use', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
    box: true,
  });

  const onLocal = await daemon.spawnSession('local');
  const onBox = await daemon.spawnSession('box');
  const client = await daemon.openTCPAs(TOKEN_A);
  const listed = await client.sendRequest('session.list', {}, 'gw');
  const got = await client.sendRequest('session.get', { session: onLocal }, 'gw');

  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id: onLocal })] });
  expect(got).toMatchObject({ session: { id: onLocal } });

  expect(client.sendRequest('session.get', { session: onBox }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: `no session '${onBox}'`,
  });
});

test('it pushes a TCP connection no event of a session it did not act on', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCPAs(TOKEN_A);

  const pushed: EventMsg[] = [];

  client.onEvent = (event) => {
    pushed.push(event);
  };

  const ownerEvents: EventMsg[] = [];

  daemon.owner.onEvent = (event) => {
    ownerEvents.push(event);
  };

  const id = await daemon.spawnSession();

  await waitFor(() => {
    expect(ownerEvents.map((event) => event.ev)).toContain('SessionAdded');
  });

  await client.sendRequest('session.list', {}, 'gw');

  expect(pushed).toStrictEqual([]);
  expect(id).toBeString();
});

test('it closes a TCP connection whose token a reload removes', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n${TOKEN_B}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const removed = await daemon.openTCPAs(TOKEN_A);
  const kept = await daemon.openTCPAs(TOKEN_B);

  const closed = Promise.withResolvers<void>();

  removed.onClose = () => {
    closed.resolve();
  };

  daemon.writeTokens(`${TOKEN_B}\n`);
  daemon.daemon.refreshTokens();

  await closed.promise;

  const listed = await kept.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a handshake with a token a reload removed', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  daemon.writeTokens(`${TOKEN_B}\n`);
  daemon.daemon.refreshTokens();

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', TOKEN_A)).rejects.toMatchObject({
    code: 'unauthorized',
  });
});

test('it closes every TCP connection and refuses every handshake after an invalid reload', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const open = await daemon.openTCPAs(TOKEN_A);

  const closed = Promise.withResolvers<void>();

  open.onClose = () => {
    closed.resolve();
  };

  daemon.writeTokens(`${TOKEN_A}\nshort\n`);
  daemon.daemon.refreshTokens();

  await closed.promise;

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', TOKEN_A)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(daemon.logged).toStrictEqual([
    expect.toStartWith('atc tcp event=listening '),
    expect.toInclude('token reload failed'),
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it takes handshakes again after a valid reload follows an invalid one', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  daemon.writeTokens('');
  daemon.daemon.refreshTokens();
  daemon.writeTokens(`${TOKEN_A}\n`);
  daemon.daemon.refreshTokens();

  const client = await daemon.openTCP();
  const hello = await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(hello).toContainKey('daemonID');
});

test('it delays the next handshake from an address after five failures within a minute', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 600,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const client = await daemon.openTCP();

  const started = Date.now();

  await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(Date.now() - started).toBeWithin(550, 5000);
});

test('it answers the handshake at once before an address has failed five times', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 600,
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const client = await daemon.openTCP();

  const started = Date.now();

  await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(Date.now() - started).toBeLessThan(550);
});

test('it refuses to start a listener on an address outside the allowed ranges', () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const tokenFile = join(tmp.dir, 'gateway-token');

  writeFileSync(tokenFile, `${TOKEN_A}\n`);

  expect(
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '0.0.0.0', port: 0, tokenFile },
    }),
  ).rejects.toMatchObject({ code: 'listen_refused' });
});

test('it refuses to start a listener whose token file holds a short token', () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const tokenFile = join(tmp.dir, 'gateway-token');

  writeFileSync(tokenFile, 'short\n');

  expect(
    startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(tmp.dir, 'state.db'),
      statusPath: join(tmp.dir, 'status.json'),
      listen: { host: '127.0.0.1', port: 0, tokenFile },
    }),
  ).rejects.toMatchObject({ code: 'listen_refused' });
});

test('it logs the address and port the TCP listener bound', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  expect(daemon.logged).toStrictEqual([
    `atc tcp event=listening host=127.0.0.1 port=${String(daemon.daemon.listenPort)}`,
  ]);
});

test('it logs no listener start when the TCP listener cannot bind', async () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const tokenFile = join(tmp.dir, 'gateway-token');
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const logged: string[] = [];

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(tokenFile, `${TOKEN_A}\n`);

  const refusal: unknown = await startDaemon({
    socketPath: join(tmp.dir, 'daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      screenDetector: null,
      takesMessages: true,
      headlessRunner: null,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'prompt-submitted' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => 'claude --resume',
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    listen: { host: '127.0.0.1', port: held.port, tokenFile },
    log: (line) => {
      logged.push(line);
    },
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'listen_refused' });
  expect(logged).toStrictEqual([]);
});

test('it logs a refused handshake with the peer and the reason', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(daemon.logged.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs no part of the token a refused handshake presents', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const presented = randomBytes(24).toString('hex');

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', presented)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(
    Array.from({ length: presented.length - 7 }, (_, at) => presented.slice(at, at + 8)),
  ).toSatisfyAll((part: string) => !daemon.logged.join('\n').includes(part));
});

test('it logs a refused principal with the principal and the peer', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCP();

  expect(
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'other',
      auth: { scheme: 'bearer', token: TOKEN_A },
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });

  expect(daemon.logged.slice(1)).toStrictEqual([
    'atc tcp event=principal_refused peer=127.0.0.1 principal=other count=1',
  ]);
});

test('it escapes the control characters of a refused principal in its log line', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
  });

  const client = await daemon.openTCP();

  expect(
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'ops\u001B[2J\r\natc tcp event=listening\u009B',
      auth: { scheme: 'bearer', token: TOKEN_A },
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });

  expect(daemon.logged.slice(1)).toStrictEqual([
    String.raw`atc tcp event=principal_refused peer=127.0.0.1 principal=ops\u{1b}[2J\u{d}\u{a}atc\u{20}tcp\u{20}event\u{3d}listening\u{9b} count=1`,
  ]);

  expect(daemon.logged[1]).not.toMatch(/\p{Cc}/u);
});

test('it folds repeated refusals from one peer within the window into one line', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  for (const token of [TOKEN_B, TOKEN_B, TOKEN_B]) {
    const client = await daemon.openTCP();

    expect(client.sendHello('atc/test-gateway', token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  daemon.advanceClock(59_999);

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(daemon.logged.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it logs a refusal after the window as a new line after the count of the folded ones', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  for (const token of [TOKEN_B, TOKEN_B, TOKEN_B]) {
    const client = await daemon.openTCP();

    expect(client.sendHello('atc/test-gateway', token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  daemon.advanceClock(60_000);

  const client = await daemon.openTCP();

  expect(client.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
    code: 'unauthorized',
  });

  expect(daemon.logged.slice(1)).toStrictEqual([
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=2',
    'atc tcp event=handshake_refused peer=127.0.0.1 reason=unauthorized count=1',
  ]);
});

test('it refuses a listener whose port another socket holds and releases the daemon lock', async () => {
  using tmp = setupTempDir('atc-daemon-tcp-');

  const tokenFile = join(tmp.dir, 'gateway-token');
  const held = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    held.stop(true);
  });

  writeFileSync(tokenFile, `${TOKEN_A}\n`);

  const refusal: unknown = await startDaemon({
    socketPath: join(tmp.dir, 'daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      screenDetector: null,
      takesMessages: true,
      headlessRunner: null,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'prompt-submitted' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => 'claude --resume',
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    listen: { host: '127.0.0.1', port: held.port, tokenFile },
  }).catch((error: unknown) => error);

  const lock = await claimDaemonLock(join(tmp.dir, 'daemon.lock'), 0);

  onTestFinished(() => {
    lock?.dispose();
  });

  expect(refusal).toMatchObject({
    code: 'listen_refused',
    message: `atc daemon: --listen cannot bind 127.0.0.1:${held.port} (EADDRINUSE)`,
  });

  expect(lock).not.toBeNull();
  expect(existsSync(join(tmp.dir, 'daemon.sock'))).toBeFalse();
  expect(existsSync(join(tmp.dir, 'daemon.json'))).toBeFalse();
});

test('it closes an unauthenticated TCP connection that sends a malformed line without a reply', async () => {
  await using daemon = await setupTest({ tokens: `${TOKEN_A}\n`, principals: new Map() });

  const port = daemon.daemon.listenPort ?? 0;
  const closed = Promise.withResolvers<void>();
  const received: string[] = [];

  await Bun.connect({
    hostname: '127.0.0.1',
    port,
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
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 600,
  });

  const port = daemon.daemon.listenPort ?? 0;

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
      port,
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

  const client = await daemon.openTCP();

  const started = Date.now();

  await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(Date.now() - started).toBeWithin(550, 5000);
});

test('it refuses a second handshake on a TCP connection and closes it', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([
      ['gw-a', ['local']],
      ['gw-b', []],
    ]),
  });

  const id = await daemon.spawnSession();
  const client = await daemon.openTCP();

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  await client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw-a',
    auth: { scheme: 'bearer', token: TOKEN_A },
  });

  await client.sendRequest('session.attach', { session: id }, 'gw-a');

  expect(
    client.sendRequest('daemon.hello', {
      client: 'atc/test-gateway',
      principal: 'gw-b',
      auth: { scheme: 'bearer', token: TOKEN_A },
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });

  await closed.promise;
});

test('it keeps answering local pings while a TCP peer floods handshakes during the delay', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 1500,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const hello = `${JSON.stringify({ v: 4, id: 1, m: 'daemon.hello', p: { auth: { scheme: 'bearer', token: TOKEN_B } } })}\n`;
  const flooded = Promise.withResolvers<void>();

  await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.daemon.listenPort ?? 0,
    socket: {
      open(socket) {
        socket.write(hello.repeat(100_000));
      },
      data() {},
      close() {
        flooded.resolve();
      },
      error() {},
    },
  });

  const latencies: number[] = [];
  const until = Date.now() + 4000;

  while (Date.now() < until) {
    const sent = Date.now();

    await daemon.owner.sendRequest('daemon.ping', {});

    latencies.push(Date.now() - sent);

    // Spaces the pings out across the delay and the moment it ends.
    await Bun.sleep(50);
  }

  await flooded.promise;

  expect(Math.max(...latencies)).toBeLessThan(500);
});

test('it refuses at once a handshake that would wait while the cap of delayed handshakes is full', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 1500,
    maxDelayedHandshakes: 3,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const waiting = await Promise.all([daemon.openTCP(), daemon.openTCP(), daemon.openTCP()]);

  const held = waiting.map((client) => client.sendHello('atc/test-gateway', TOKEN_A));

  const over = await daemon.openTCP();

  const started = Date.now();
  const refused = over.sendHello('atc/test-gateway', TOKEN_A);

  expect(refused).rejects.toMatchObject({ code: 'unauthorized' });

  await Promise.allSettled([refused]);

  expect(Date.now() - started).toBeLessThan(500);

  const answers = await Promise.all(held);

  expect(answers).toHaveLength(3);
});

test('it ends a delayed handshake once its socket closes and frees its place in the cap', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 1500,
    maxDelayedHandshakes: 2,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const abandoned = await Promise.all([daemon.openTCP(), daemon.openTCP()]);

  const abandonedHellos = Promise.allSettled(
    abandoned.map((client) => client.sendHello('atc/test-gateway', TOKEN_A)),
  );

  // Lets the daemon read both handshakes before the sockets close.
  await Bun.sleep(100);

  for (const client of abandoned) {
    client.stop();
  }

  await Bun.sleep(100);

  const client = await daemon.openTCP();

  const started = Date.now();

  await client.sendHello('atc/test-gateway', TOKEN_A);

  expect(Date.now() - started).toBeWithin(1400, 5000);

  await abandonedHellos;
});

test('it keeps answering local pings while many TCP sockets each send a handshake during the delay', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map(),
    failureDelayMs: 1500,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const failing = await daemon.openTCP();

    expect(failing.sendHello('atc/test-gateway', TOKEN_B)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  }

  const flood = await Promise.all(Array.from({ length: 300 }, () => daemon.openTCP()));

  const floodHellos = Promise.allSettled(
    flood.map((client) => client.sendHello('atc/test-gateway', TOKEN_B)),
  );

  const latencies: number[] = [];
  const until = Date.now() + 2000;

  while (Date.now() < until) {
    const sent = Date.now();

    await daemon.owner.sendRequest('daemon.ping', {});

    latencies.push(Date.now() - sent);

    await Bun.sleep(50);
  }

  await floodHellos;

  expect(Math.max(...latencies)).toBeLessThan(500);
}, 20_000);

test('it pushes a TCP connection whose handshake gives a principal the removal of a session that leaves its reach', async () => {
  await using daemon = await setupTest({
    tokens: `${TOKEN_A}\n`,
    principals: new Map([['gw', ['local']]]),
    box: true,
  });

  const parent = await daemon.spawnSession('local');
  const client = await daemon.openTCP();

  await client.sendRequest('daemon.hello', {
    client: 'atc/test-gateway',
    principal: 'gw',
    auth: { scheme: 'bearer', token: TOKEN_A },
  });

  const pushed: EventMsg[] = [];

  client.onEvent = (event) => {
    pushed.push(event);
  };

  await daemon.owner.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    parent,
    resume: `a-${randomUUID()}`,
  });

  await waitFor(() => {
    const removed = pushed.filter((event) => event.ev === 'SessionRemoved');

    expect(removed.map((event) => event['s'])).toStrictEqual([parent]);
  });
});
