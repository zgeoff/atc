import { expect, mock, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V } from '@atc/protocol/wire';
import {
  buildMockAgentAdapter,
  buildStubSkipClock,
  setupTempDir,
  startStubLegacyDaemon,
  startStubRefusingListener,
  startStubUnansweringListener,
} from '@atc/test-utils';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';
import { startTestDaemon } from './test-utils/start-test-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-remote-boot-');

  return {
    directory: temporaryDirectory.path,
    tokenFile: join(temporaryDirectory.path, 'box.token'),
  };
}

test('it connects to a daemon over TCP as the entry principal and lists its fleet', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'gateway-token') },
      };
    },
  });

  if (daemon.daemon.listenPort === null) {
    throw new Error('the test daemon bound no TCP port');
  }

  await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'claude',
    name: 'on-the-box',
    cols: 80,
    rows: 24,
  });

  const boot = await bootRemoteDaemonClient(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: daemon.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => {
    boot.client.stop();
  });

  const listed = await boot.client.sendRequest('session.list');

  expect(boot).toMatchObject({
    stale: false,
    socketPath: `127.0.0.1:${daemon.daemon.listenPort}`,
  });

  expect(listed['sessions']).toStrictEqual([
    expect.objectContaining({ name: 'on-the-box', alive: true }),
  ]);
});

test('it refuses a viewer on a daemon whose handshake lists no viewer feature, naming the daemon', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    {
      replies: {
        'daemon.hello': {
          daemon: 'atc/legacy-build',
          daemonID: 'd-legacy',
          limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
          lastUsedAgent: 'claude',
          features: ['events.read.from-start'],
        },
      },
    },
  );

  if (legacy.port === null) {
    throw new Error('the stub daemon bound no TCP port');
  }

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port: legacy.port,
        token: { kind: 'file', path: ctx.tokenFile },
        principal: 'laptop',
      }),
      'atc/test-client',
      { viewer: 'web-panel' },
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `daemon 'box' at 127.0.0.1:${legacy.port} cannot narrow a connection to the principal 'web-panel', so it serves no live terminal to it; update atc on the daemon's host`,
  );
});

test('it connects with no viewer to a daemon whose handshake lists no viewer feature', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const legacy = startStubLegacyDaemon({ hostname: '127.0.0.1', port: 0 });

  if (legacy.port === null) {
    throw new Error('the stub daemon bound no TCP port');
  }

  const boot = await bootRemoteDaemonClient(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: legacy.port,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => {
    boot.client.stop();
  });

  expect(legacy.requests).toStrictEqual([
    {
      method: 'daemon.hello',
      params: {
        protocol: PROTOCOL_V,
        client: 'atc/test-client',
        auth: { scheme: 'bearer', token: 'a'.repeat(32) },
        principal: 'laptop',
      },
    },
  ]);
});

test('it rejects an unreachable daemon with its name and address and never waits without being asked', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  // A port the kernel handed out and this test then freed, so nothing
  // listens on it.
  const freed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = freed.port;

  freed.stop(true);

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port,
        token: { kind: 'file', path: ctx.tokenFile },
      }),
      'atc/test-client',
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `cannot reach daemon 'box' at 127.0.0.1:${port}: ECONNREFUSED. atc did not fall back to the local daemon.`,
  );
});

test('it rejects a daemon on another protocol with both builds and versions and never offers a restart', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const legacy = startStubLegacyDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { protocol: PROTOCOL_V + 1 },
  );

  if (legacy.port === null) {
    throw new Error('the stub daemon bound no TCP port');
  }

  const onProtocolMismatch = mock(() => Promise.resolve(true));

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port: legacy.port,
        token: { kind: 'file', path: ctx.tokenFile },
      }),
      'atc/test-client',
      { onProtocolMismatch },
    ),
  ).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: [
      `daemon 'box' at 127.0.0.1:${legacy.port} speaks another protocol than this client, atc/test-client on protocol v${PROTOCOL_V}.`,
      `The daemon answered: atc/test-client speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
      "atc did not fall back to the local daemon. Run an atc build on the daemon's protocol here, or update the daemon on its host.",
    ].join('\n'),
  });

  expect(onProtocolMismatch).not.toHaveBeenCalled();
});

test.each([
  {
    refused: 'a token the daemon does not hold',
    token: 'b'.repeat(32),
    principal: 'laptop',
    reason: 'daemon.hello over TCP needs a valid bearer token',
  },
  {
    refused: 'a principal the daemon does not list',
    token: 'a'.repeat(32),
    principal: 'phone-app',
    reason: "principal 'phone-app' is not listed in principals",
  },
])('it rejects $refused as unauthorized, naming the principal', async (row) => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${row.token}\n`);

  const daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.directory, 'gateway-token'),
          failureDelayMs: 0,
        },
      };
    },
  });

  if (daemon.daemon.listenPort === null) {
    throw new Error('the test daemon bound no TCP port');
  }

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port: daemon.daemon.listenPort,
        token: { kind: 'file', path: ctx.tokenFile },
        principal: row.principal,
      }),
      'atc/test-client',
    ),
  ).rejects.toMatchObject({
    code: 'unauthorized',
    message: `daemon 'box' at 127.0.0.1:${daemon.daemon.listenPort} refused the handshake as principal '${row.principal}': ${row.reason}. atc did not fall back to the local daemon.`,
  });
});

test('it accepts a listed principal with a token the daemon holds', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const daemon = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildMockAgentAdapter(),
        principals: new Map([['laptop', ['local']]]),
        listen: {
          host: '127.0.0.1',
          port: 0,
          tokenFile: join(paths.directory, 'gateway-token'),
          failureDelayMs: 0,
        },
      };
    },
  });

  if (daemon.daemon.listenPort === null) {
    throw new Error('the test daemon bound no TCP port');
  }

  const boot = await bootRemoteDaemonClient(
    buildMockRemoteDaemon({
      name: 'box',
      host: '127.0.0.1',
      port: daemon.daemon.listenPort,
      token: { kind: 'file', path: ctx.tokenFile },
      principal: 'laptop',
    }),
    'atc/test-client',
  );

  onTestFinished(() => {
    boot.client.stop();
  });

  expect(boot.client.principal).toBe('laptop');
});

test('it rejects a daemon that takes the connection but never answers once the timeout passes', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const listener = startStubUnansweringListener();

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port: listener.port,
        token: { kind: 'file', path: ctx.tokenFile },
      }),
      'atc/test-client',
      { answerTimeoutMs: 50 },
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `cannot reach daemon 'box' at 127.0.0.1:${listener.port}: no handshake answer within 0.05s. atc did not fall back to the local daemon.`,
  );
});

test('it rejects a token it cannot read before it connects', () => {
  const ctx = setupTest();

  expect(
    bootRemoteDaemonClient(
      buildMockRemoteDaemon({
        name: 'box',
        host: '127.0.0.1',
        port: 7420,
        token: { kind: 'file', path: ctx.tokenFile },
      }),
      'atc/test-client',
    ),
  ).rejects.toThrowWithMessage(
    Error,
    `daemon 'box': cannot read its token file ${ctx.tokenFile} (ENOENT). atc did not fall back to the local daemon.`,
  );
});

test('it waits for a daemon that drops the handshake, once asked to wait, until one answers', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const closing = startStubRefusingListener();
  const onWaitForDaemon = mock();

  const daemon = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: closing.port,
    token: { kind: 'file', path: ctx.tokenFile },
  });

  const booted = bootRemoteDaemonClient(daemon, 'atc/test-client', {
    clock: buildStubSkipClock(),
    onWaitForDaemon: () => {
      onWaitForDaemon();

      // The daemon comes back on the same port once the client first waits.
      closing.stop();

      startStubLegacyDaemon({ hostname: '127.0.0.1', port: closing.port });
    },
  });

  const boot = await booted;

  onTestFinished(() => {
    boot.client.stop();
  });

  expect(boot.socketPath).toBe(`127.0.0.1:${closing.port}`);
  expect(onWaitForDaemon).toHaveBeenCalledOnce();
});

test('it stops waiting for a daemon that drops the handshake once the wait deadline passes', () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const closing = startStubRefusingListener();

  const daemon = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: closing.port,
    token: { kind: 'file', path: ctx.tokenFile },
  });

  expect(
    bootRemoteDaemonClient(daemon, 'atc/test-client', {
      clock: buildStubSkipClock(),
      waitForDaemonMs: 3000,
      onWaitForDaemon: () => {},
    }),
  ).rejects.toThrowWithMessage(Error, /^cannot reach daemon 'box' at 127\.0\.0\.1:\d+: /u);
});

test('it rests no longer than the wait deadline between attempts at a daemon that drops the handshake', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const closing = startStubRefusingListener();
  const clock = buildStubSkipClock();

  const daemon = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: closing.port,
    token: { kind: 'file', path: ctx.tokenFile },
  });

  const failure = await bootRemoteDaemonClient(daemon, 'atc/test-client', {
    clock,
    waitForDaemonMs: 2500,
    onWaitForDaemon: () => {},
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(clock.now()).toBe(2500);
});

test.each([
  { budget: 'no time', waitForDaemonMs: 0 },
  { budget: 'a negative time', waitForDaemonMs: -500 },
])('it rejects a wait of $budget before it connects', (row) => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const closing = startStubRefusingListener();

  const daemon = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: closing.port,
    token: { kind: 'file', path: ctx.tokenFile },
  });

  expect(
    bootRemoteDaemonClient(daemon, 'atc/test-client', {
      clock: buildStubSkipClock(),
      waitForDaemonMs: row.waitForDaemonMs,
      onWaitForDaemon: () => {},
    }),
  ).rejects.toThrowWithMessage(
    Error,
    `cannot reach daemon 'box' at 127.0.0.1:${closing.port}: the wait for it ended before an attempt. atc did not fall back to the local daemon.`,
  );

  expect(closing.received).toStrictEqual([]);
});

test('it ends an attempt that gets no handshake answer at the wait deadline', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n`);

  const silent = startStubUnansweringListener();
  const clock = buildStubSkipClock();

  const daemon = buildMockRemoteDaemon({
    name: 'box',
    host: '127.0.0.1',
    port: silent.port,
    token: { kind: 'file', path: ctx.tokenFile },
  });

  const failure = await bootRemoteDaemonClient(daemon, 'atc/test-client', {
    clock,
    waitForDaemonMs: 3000,
    answerTimeoutMs: 8000,
    onWaitForDaemon: () => {},
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(clock.now()).toBe(3000);
});
