import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import {
  buildMockExecutionTarget,
  buildStubMemoryProvider,
  startTestDaemon,
} from '@atc/daemon/testing';
import {
  createEnrollmentToken,
  createTransportCaller,
  openMCPAuth,
  readGrantViews,
  revokeGrant,
  startMCPHTTPServer,
} from '@atc/mcp';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubAuthenticator,
  getRecord,
  getString,
  openPTYViewer,
  registerTestCleanup,
  runMCPTokenGrant,
  runPasskeyEnrollment,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from '../packages/app/src/open-mcp-auth-database';
import { openWatchChannel } from '../packages/app/src/open-watch-channel';

interface StackOptions {
  readonly ownerTokens: readonly string[];
  readonly viewerBufferBytes?: number;
  readonly viewerAccessRecheckMs?: number;
}

// Each stack is one daemon, with its own state and sockets, and its own
// `atc mcp --http` server on a free port with its own authorization database.
function setupTest() {
  const authRoot = setupTempDir('atc-live-terminal-auth-');

  const startStack = async (options: StackOptions) => {
    const provider = buildStubMemoryProvider({ kind: 'local-pty', capabilities: { resize: true } });

    // OAuth client ids are minted when a client is added, so a test lists
    // its client here once it has one; an unlisted client sees no session.
    const principals = new Map<string, readonly string[]>();

    const daemon = await startTestDaemon({
      prefix: 'atc-live-terminal-',
      options: () => ({
        adapter: buildMockAgentAdapter(),
        targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
        principals,
      }),
    });

    const caller = createTransportCaller(daemon.socketPath, daemon.build, (path) =>
      openDaemonClient(path),
    );

    registerTestCleanup(() => caller.stop());

    const dbPath = join(mkdtempSync(join(authRoot.path, 'stack-')), 'mcp-auth.db');
    const requests: string[] = [];

    const server = await startMCPHTTPServer({
      caller,
      build: daemon.build,
      host: '127.0.0.1',
      port: 0,
      publicURL: null,
      allowedHosts: [],
      trustForwardedFrom: [],
      dbPath,
      openAuthDatabase: openMCPAuthDatabase,
      printRequest: (line) => {
        requests.push(line);
      },
      printSecurity: () => {},
      liveTerminals: {
        allowedOrigins: ['https://panel.example.com'],
        openWatchChannel: (principal) =>
          openWatchChannel(daemon.socketPath, daemon.build, principal),
        ...options,
      },
    });

    registerTestCleanup(() => server.stop());

    const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

    registerTestCleanup(() => store.close());

    const grantToken = async (scopes: readonly string[]) => {
      const authenticator = buildStubAuthenticator();

      const enrollment = await createEnrollmentToken(store.db, Date.now());

      await runPasskeyEnrollment(server, enrollment.token, authenticator);

      const created = await store.auth.api.createFixedClient({
        body: { name: 'Panel', redirectURIs: ['https://panel.example.com/callback'] },
      });

      const grant = await runMCPTokenGrant(
        { url: server.url, origin: server.origin, authenticator },
        {
          clientID: created.clientID,
          redirectURI: 'https://panel.example.com/callback',
          scope: scopes.join(' '),
          ticked: scopes,
        },
      );

      return { clientID: created.clientID, accessToken: grant.accessToken, authenticator };
    };

    // A second grant to the client of an earlier one, signed in with the same
    // passkey.
    const grantAgain = async (
      earlier: Awaited<ReturnType<typeof grantToken>>,
      scopes: readonly string[],
    ) => {
      const grant = await runMCPTokenGrant(
        { url: server.url, origin: server.origin, authenticator: earlier.authenticator },
        {
          clientID: earlier.clientID,
          redirectURI: 'https://panel.example.com/callback',
          scope: scopes.join(' '),
          ticked: scopes,
        },
      );

      return { clientID: earlier.clientID, accessToken: grant.accessToken };
    };

    const spawnSession = async () => {
      const spawned = await daemon.client.sendRequest('session.spawn', {
        cwd: daemon.directory,
        cols: 80,
        rows: 24,
      });

      const harness = provider.harnesses.at(-1);

      invariant(harness, 'the spawn started no terminal');

      return { id: getString(getRecord(spawned, 'session'), 'id'), harness };
    };

    const ptyURL = (sessionID: string) =>
      `${server.url.replace('http:', 'ws:')}/sessions/${sessionID}/pty`;

    return {
      daemon,
      server,
      store,
      requests,
      principals,
      grantToken,
      grantAgain,
      spawnSession,
      ptyURL,
    };
  };

  return { startStack };
}

test('it streams the replayed screen and then the output a session prints, in sequence order, to a viewer with an OAuth token', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [] });
  const grant = await stack.grantToken(['read']);

  stack.principals.set(grant.clientID, ['local']);

  const session = await stack.spawnSession();

  session.harness.emitData('compiling\r\n');

  const viewer = await openPTYViewer(stack.ptyURL(session.id), {
    token: grant.accessToken,
    origin: 'https://panel.example.com',
  });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(1);
  });

  session.harness.emitData('step one\r\n');
  session.harness.emitData('step two\r\n');

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(3);
  });

  expect(viewer.frames).toStrictEqual([
    {
      kind: 'control',
      frame: {
        type: 'snapshot',
        cols: 80,
        rows: 24,
        seq: 0,
        state: 'running',
        data: expect.toInclude('compiling'),
      },
    },
    { kind: 'output', data: 'step one\r\n' },
    { kind: 'output', data: 'step two\r\n' },
  ]);
});

test('it refuses an upgrade that carries no token before it upgrades', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [] });
  const session = await stack.spawnSession();

  const answered = await fetch(stack.ptyURL(session.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'atc.pty.v1',
    },
  });

  expect(answered.status).toBe(401);
});

test('it refuses a token whose client cannot see the session as if the session did not exist', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [] });
  const grant = await stack.grantToken(['read']);
  const session = await stack.spawnSession();

  const answered = await fetch(stack.ptyURL(session.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `atc.pty.v1, atc.bearer.${Buffer.from(grant.accessToken).toString('base64url')}`,
    },
  });

  expect(answered.status).toBe(404);
});

test('it streams to a viewer that presents the token from the owner token file', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: ['p'.repeat(32)] });
  const session = await stack.spawnSession();

  session.harness.emitData('owner view\r\n');

  const viewer = await openPTYViewer(stack.ptyURL(session.id), { token: 'p'.repeat(32) });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(1);
  });

  expect(viewer.frames).toPartiallyContain({
    kind: 'control',
    frame: expect.objectContaining({ type: 'snapshot', data: expect.toInclude('owner view') }),
  });
});

test.each([
  ['a token not in the owner token file', 'q'.repeat(32), 'https://panel.example.com', 401],
  ['an empty token', '', 'https://panel.example.com', 401],
  ['the owner token with one more character', 'p'.repeat(33), 'https://panel.example.com', 401],
  ['the owner token less its last character', 'p'.repeat(31), 'https://panel.example.com', 401],
  ['the owner token in capitals', 'P'.repeat(32), 'https://panel.example.com', 401],
  ['the owner token with a newline', `${'p'.repeat(32)}\n`, 'https://panel.example.com', 401],
  ['the owner token in spaces', ` ${'p'.repeat(32)} `, 'https://panel.example.com', 401],
  [
    'a token shaped like an access token that was never issued',
    'Zm9yZ2VkLWFjY2Vzcy10b2tlbi0wMDAwMDAwMDAw',
    'https://panel.example.com',
    401,
  ],
  ['an origin not on the allowed list', 'p'.repeat(32), 'https://elsewhere.example.com', 403],
])('it refuses %s before it upgrades', async (_label, token, origin, status) => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: ['p'.repeat(32)] });
  const session = await stack.spawnSession();

  const answered = await fetch(stack.ptyURL(session.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      origin,
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `atc.pty.v1, atc.bearer.${Buffer.from(token).toString('base64url')}`,
    },
  });

  expect(answered.status).toBe(status);
});

test('it refuses an access token without the read scope with 403 before it upgrades', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [] });
  const grant = await stack.grantToken(['message']);

  stack.principals.set(grant.clientID, ['local']);

  const session = await stack.spawnSession();

  const answered = await fetch(stack.ptyURL(session.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `atc.pty.v1, atc.bearer.${Buffer.from(grant.accessToken).toString('base64url')}`,
    },
  });

  expect(answered.status).toBe(403);
});

test('it refuses the access token of a revoked grant before it upgrades', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [] });
  const grant = await stack.grantToken(['read']);

  stack.principals.set(grant.clientID, ['local']);

  const session = await stack.spawnSession();
  const [granted] = await readGrantViews(stack.store.db);

  invariant(granted, 'the token grant left no grant');

  await revokeGrant(stack.store.db, granted.grantID, Date.now());

  const answered = await fetch(stack.ptyURL(session.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `atc.pty.v1, atc.bearer.${Buffer.from(grant.accessToken).toString('base64url')}`,
    },
  });

  expect(answered.status).toBe(401);
});

test('it ends an open stream as revoked once the grant it opened with is revoked, while another grant of its client still reads', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: [], viewerAccessRecheckMs: 20 });
  const first = await stack.grantToken(['read']);
  const [firstGrant] = await readGrantViews(stack.store.db);

  invariant(firstGrant, 'the first token grant left no grant');

  const second = await stack.grantAgain(first, ['read']);

  stack.principals.set(first.clientID, ['local']);

  const session = await stack.spawnSession();

  const viewer = await openPTYViewer(stack.ptyURL(session.id), {
    token: first.accessToken,
    origin: 'https://panel.example.com',
  });

  await revokeGrant(stack.store.db, firstGrant.grantID, Date.now());

  const closed = await viewer.closed;

  const other = await openPTYViewer(stack.ptyURL(session.id), {
    token: second.accessToken,
    origin: 'https://panel.example.com',
  });

  await waitFor(() => {
    expect(other.frames).toHaveLength(1);
  });

  expect(closed.code).toBe(1000);
  expect(closed.reason).toBe('revoked');

  expect(viewer.frames.at(-1)).toStrictEqual({
    kind: 'control',
    frame: { type: 'closed', reason: 'revoked' },
  });

  expect(other.frames).toStrictEqual([
    { kind: 'control', frame: expect.objectContaining({ type: 'snapshot' }) },
  ]);
});

test('it answers a live-terminal path whose session id holds a broken escape with 400, and logs it', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: ['p'.repeat(32)] });

  const answered = await fetch(`${stack.server.url}/sessions/%/pty`, {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `atc.pty.v1, atc.bearer.${Buffer.from('p'.repeat(32)).toString('base64url')}`,
    },
  });

  expect(answered.status).toBe(400);
  expect(stack.requests).toContainEqual(expect.toStartWith('GET /sessions/%/pty 400 '));
});

test('it refuses an owner token file on a bind other machines can reach', () => {
  const dbPath = join(setupTempDir('atc-live-terminal-bind-').path, 'mcp-auth.db');

  const caller = createTransportCaller(join(dbPath, 'no.sock'), 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  expect(
    startMCPHTTPServer({
      caller,
      build: 'atc/test-build',
      host: '0.0.0.0',
      port: 0,
      publicURL: 'https://mcp.example.com',
      allowedHosts: [],
      trustForwardedFrom: [],
      dbPath,
      openAuthDatabase: openMCPAuthDatabase,
      printRequest: () => {},
      printSecurity: () => {},
      liveTerminals: {
        allowedOrigins: [],
        ownerTokens: ['p'.repeat(32)],
        openWatchChannel: () => Promise.reject(new Error('no daemon')),
      },
    }),
  ).rejects.toThrow(
    "a token file opens live terminals as the owner, so it needs a loopback bind, not '0.0.0.0'",
  );
});

test('it leaves the session at its attached size and as it was once a viewer comes and goes', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: ['p'.repeat(32)] });
  const session = await stack.spawnSession();
  const attached = await stack.daemon.openClient();

  await attached.sendRequest('session.attach', { session: session.id, cols: 120, rows: 30 });

  await waitFor(() => {
    expect(session.harness.sizes).toStrictEqual([[120, 30]]);
  });

  const before = await stack.daemon.client.sendRequest('session.get', { session: session.id });
  const viewer = await openPTYViewer(stack.ptyURL(session.id), { token: 'p'.repeat(32) });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(1);
  });

  viewer.socket.close();

  await viewer.closed;

  const after = await stack.daemon.client.sendRequest('session.get', { session: session.id });

  expect(viewer.frames).toPartiallyContain({
    kind: 'control',
    frame: expect.objectContaining({ type: 'snapshot', cols: 120, rows: 30 }),
  });

  expect(session.harness.sizes).toStrictEqual([[120, 30]]);
  expect(after).toStrictEqual(before);
});

test('it keeps streaming to other clients while a viewer stops reading', async () => {
  const ctx = setupTest();

  const stack = await ctx.startStack({ ownerTokens: ['p'.repeat(32)], viewerBufferBytes: 0 });
  const session = await stack.spawnSession();

  const url = new URL(stack.ptyURL(session.id));

  // A viewer that completes the handshake and then never reads again.
  const stalled = createConnection({ host: url.hostname, port: Number(url.port) });

  registerTestCleanup(() => {
    stalled.destroy();
  });

  const upgraded = Promise.withResolvers<void>();

  stalled.once('data', () => {
    stalled.pause();
    upgraded.resolve();
  });

  stalled.write(
    [
      `GET ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Protocol: atc.pty.v1, atc.bearer.${Buffer.from('p'.repeat(32)).toString('base64url')}`,
      '',
      '',
    ].join('\r\n'),
  );

  await upgraded.promise;

  const reading = await openPTYViewer(stack.ptyURL(session.id), { token: 'p'.repeat(32) });
  const attached = await stack.daemon.openClient();

  const attachedEvents: unknown[] = [];

  attached.onEvent = (event) => {
    attachedEvents.push(event);
  };

  await attached.sendRequest('session.attach', { session: session.id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(reading.frames).toHaveLength(1);
  });

  const line = `${'x'.repeat(1023)}\n`;

  for (let chunk = 0; chunk < 1024; chunk++) {
    session.harness.emitData(line);
  }

  session.harness.emitData('all printed');

  // A client that falls behind on its own takes a repaint, so the marker may
  // reach it as output or inside a replay.
  await waitFor(() => {
    expect(attachedEvents).toContainEqual(
      expect.objectContaining({ ev: 'SessionOutput', data: expect.toInclude('all printed') }),
    );

    expect(reading.readScreen()).toInclude('all printed');
  });
});

test('it streams each daemon only its own sessions and refuses a token another daemon granted', async () => {
  const ctx = setupTest();

  const first = await ctx.startStack({ ownerTokens: [] });
  const second = await ctx.startStack({ ownerTokens: [] });
  const firstGrant = await first.grantToken(['read']);
  const secondGrant = await second.grantToken(['read']);

  first.principals.set(firstGrant.clientID, ['local']);
  second.principals.set(secondGrant.clientID, ['local']);

  const firstSession = await first.spawnSession();
  const secondSession = await second.spawnSession();

  firstSession.harness.emitData('first daemon\r\n');
  secondSession.harness.emitData('second daemon\r\n');

  const viewer = await openPTYViewer(first.ptyURL(firstSession.id), {
    token: firstGrant.accessToken,
  });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(1);
  });

  const firstProtocols = `atc.pty.v1, atc.bearer.${Buffer.from(firstGrant.accessToken).toString('base64url')}`;

  const otherSession = await fetch(first.ptyURL(secondSession.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': firstProtocols,
    },
  });

  const otherToken = await fetch(second.ptyURL(secondSession.id).replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': firstProtocols,
    },
  });

  expect(viewer.frames).toStrictEqual([
    {
      kind: 'control',
      frame: expect.objectContaining({ type: 'snapshot', data: expect.toInclude('first daemon') }),
    },
  ]);

  expect(otherSession.status).toBe(404);
  expect(otherToken.status).toBe(401);
});
