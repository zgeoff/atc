import { expect, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { MAX_LINE, PROTOCOL_V } from '@atc/protocol/wire';
import {
  buildPeerRequestLine,
  buildStubPeerSocket,
  parsePeerFrame,
  runCommand,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import type { PeerFrame } from '@atc/test-utils';
import type { DaemonEvent, SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import type { DaemonContext } from '../daemon-context';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { startConnectionListener } from '../testing/start-connection-listener';
import { createDaemonConnection } from './create-daemon-connection';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-daemon-connection-');

  return { socketPath: join(temporaryDirectory.path, 'daemon.sock') };
}

test('it answers a peer client request with what its procedure returns', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext({ ackSession: () => true }));

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  const answer = await client.sendRequest('session.ack', { session: 's-1' });

  expect(answer).toStrictEqual({});
});

test("it refuses a request through a session's bridge whose method its atc access cannot open", async () => {
  const ctx = setupTest();

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      findHeldAtcAccess: () => ({
        scopes: ['read', 'message', 'spawn', 'kill'],
        grant: { target: 'box', targetIdentity: 'remote:a' },
        parent: null,
        spawner: null,
      }),
    }),
    null,
    { id: toSessionID('s-1'), isBridgeCurrent: () => true },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('dirs.list', {})).rejects.toMatchObject({
    code: 'unauthorized',
    message: "dirs.list is closed to a session's atc access",
  });
});

test("it refuses a request through a session's bridge that needs a scope the session does not hold", async () => {
  const ctx = setupTest();

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      ackSession: () => true,
      findHeldAtcAccess: () => ({
        scopes: ['read'],
        grant: { target: 'box', targetIdentity: 'remote:a' },
        parent: null,
        spawner: null,
      }),
    }),
    null,
    { id: toSessionID('s-1'), isBridgeCurrent: () => true },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('session.ack', { session: 's-1' })).rejects.toMatchObject({
    code: 'unauthorized',
    message: "session.ack needs atc scope message, which session 's-1' does not hold",
  });
});

test("it answers a request through a session's bridge that a scope the session holds opens", async () => {
  const ctx = setupTest();

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      ackSession: () => true,
      findHeldAtcAccess: () => ({
        scopes: ['message'],
        grant: { target: 'box', targetIdentity: 'remote:a' },
        parent: null,
        spawner: null,
      }),
    }),
    null,
    { id: toSessionID('s-1'), isBridgeCurrent: () => true },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  const answer = await client.sendRequest('session.ack', { session: 's-1' });

  expect(answer).toStrictEqual({});
});

test("it refuses a request through a session's bridge once the session has started again", async () => {
  const ctx = setupTest();
  let current = true;

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      findHeldAtcAccess: () => ({
        scopes: ['read'],
        grant: { target: 'box', targetIdentity: 'remote:a' },
        parent: null,
        spawner: null,
      }),
    }),
    null,
    { id: toSessionID('s-1'), isBridgeCurrent: () => current },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  current = false;

  expect(client.sendRequest('session.list', {})).rejects.toMatchObject({
    code: 'unauthorized',
    message: "session 's-1' started or moved again since this connection opened",
  });
});

test('it refuses a request through the bridge of a session that holds no atc access', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext(), null, {
    id: toSessionID('s-1'),
    isBridgeCurrent: () => true,
  });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('session.list', {})).rejects.toMatchObject({
    code: 'unauthorized',
    message: "session 's-1' holds no atc access",
  });
});

test("it refuses a handshake through a session's bridge that acts as a principal", async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext(), null, {
    id: toSessionID('s-1'),
    isBridgeCurrent: () => true,
  });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test', { principal: 'chat' })).rejects.toMatchObject({
    code: 'unauthorized',
    message: "a session's atc access acts as no principal",
  });
});

test('it refuses a peer client request with the code its procedure throws', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext({ ackSession: () => false }));

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('session.ack', { session: 's-2' })).rejects.toMatchObject({
    code: 'no_such_session',
    message: "no session 's-2'",
  });
});

test('it refuses peer params the schema refuses with the first issue as bad_args', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('daemon.backup', { path: 'relative.db' })).rejects.toMatchObject({
    code: 'bad_args',
    message: 'daemon.backup path must be an absolute path',
  });
});

test('it refuses a peer method no procedure answers', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  expect(client.sendRequest('session.nope')).rejects.toMatchObject({
    code: 'unknown_method',
    message: "unknown method 'session.nope'",
  });
});

test('it refuses a peer request before the handshake and ends the connection', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const refused = client.sendRequest('daemon.ping');

  expect(refused).rejects.toMatchObject({
    code: 'unauthorized',
    message: 'daemon.hello must be the first request',
  });

  await refused.catch(() => {});

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });
});

test('it refuses a peer handshake that speaks another protocol and ends the connection', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const refused = client.sendRequest('daemon.hello', { client: 'atc/old', protocol: 1 });

  expect(refused).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/old speaks protocol v1, daemon atc/test speaks v12; update or reopen the client so both run the same build',
    data: { daemonProtocol: 12 },
  });

  await refused.catch(() => {});

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });
});

test('it tells a peer client on a later protocol to restart the daemon', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(
    client.sendRequest('daemon.hello', { client: 'atc/new', protocol: 13 }),
  ).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/new speaks protocol v13, daemon atc/test speaks v12; restart the daemon so both run the same build',
    data: { daemonProtocol: 12 },
  });
});

test('it refuses an owner-only procedure to a peer client that acts as a principal', async () => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test', { principal: 'narrow' });

  expect(client.sendRequest('daemon.quit')).rejects.toMatchObject({
    code: 'unauthorized',
    message: "daemon.quit is open to the daemon's owner only",
  });
});

test('it delivers the connection events to a peer client through its subscription', async () => {
  const ctx = setupTest();
  const connections = startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  connections[0]?.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-gone' });

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionRemoved', sessionID: 's-gone' }]);
  });
});

test('it delivers a peer client that acts as a principal no event of a session out of its reach', async () => {
  const ctx = setupTest();

  const connections = startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      buildTargetAccess: () => buildTargetAccessFromGrants([]),
      canSeeSession: (sessionID) => sessionID === 's-seen',
    }),
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test', { principal: 'narrow' });

  connections[0]?.sendOutput(
    toSessionID('s-hidden'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-hidden', seq: 1, data: 'secret' },
    6,
  );

  connections[0]?.sendOutput(
    toSessionID('s-seen'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's-seen', seq: 1, data: 'shown' },
    5,
  );

  await waitFor(() => {
    expect(events).toStrictEqual([
      { ev: 'SessionOutput', sessionID: 's-seen', seq: 1, data: 'shown' },
    ]);
  });
});

test.each([
  {
    label: 'the handshake',
    method: 'daemon.quit',
    params: {},
    hello: { principal: 'narrow' },
    as: undefined,
  },
  {
    label: 'the handshake',
    method: 'daemon.backup',
    params: { path: '/backup.db' },
    hello: { principal: 'narrow' },
    as: undefined,
  },
  { label: 'a request header', method: 'daemon.quit', params: {}, hello: {}, as: 'narrow' },
  {
    label: 'a request header',
    method: 'daemon.backup',
    params: { path: '/backup.db' },
    hello: {},
    as: 'narrow',
  },
])('it refuses a principal given in $label the owner-only $method', async (row) => {
  const ctx = setupTest();

  startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test', row.hello);

  expect(client.sendRequest(row.method, row.params, row.as)).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${row.method} is open to the daemon's owner only`,
  });
});

test("it runs an owner-only procedure for the daemon's owner", async () => {
  const ctx = setupTest();
  const quit = mock(() => {});

  startConnectionListener(ctx.socketPath, buildStubDaemonContext({ quitDaemon: quit }));

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  const answer = await client.sendRequest('daemon.quit');

  expect(answer).toStrictEqual({});
  expect(quit).toHaveBeenCalledOnce();
});

// The URL a peer request carries resolves dot segments before the daemon
// reads its path, so those reach the owner-only check by their canonical
// name; every other form names no procedure.
test.each([
  ['a trailing slash', '/daemon/quit/', 'unknown_method'],
  ['a doubled leading slash', '//daemon/quit', 'unknown_method'],
  ['a doubled inner slash', '/daemon//quit', 'unknown_method'],
  ['a dot segment', '/daemon/./quit', 'unauthorized'],
  ['a parent segment', '/session/../daemon/quit', 'unauthorized'],
])(
  'it refuses a principal a path to an owner-only procedure written with %s',
  async (_label, path, code) => {
    const ctx = setupTest();
    const quit = mock(() => {});

    startConnectionListener(ctx.socketPath, buildStubDaemonContext({ quitDaemon: quit }));

    const lines: PeerFrame[] = [];

    const raw = await Bun.connect({
      unix: ctx.socketPath,
      socket: {
        data(_socket, buf) {
          const written = buf.toString().split('\n').filter(Boolean);

          lines.push(...written.map((line) => parsePeerFrame(line)));
        },
      },
    });

    onTestFinished(() => {
      raw.end();
    });

    const hello = { client: 'atc/test', protocol: PROTOCOL_V, principal: 'narrow' };

    raw.write(
      buildPeerRequestLine('1', '/daemon/hello', hello) + buildPeerRequestLine('2', path, {}),
    );

    const refusal: unknown = expect.objectContaining({ code });

    await waitFor(() => {
      expect<unknown[]>(lines).toContainEqual(expect.objectContaining({ id: '2', body: refusal }));
    });

    expect(quit).not.toHaveBeenCalled();
  },
);

test('it serves a TCP peer client whose token and principal check out, its events included', async () => {
  const ctx = setupTest();
  const listed: Readonly<Record<string, boolean>> = { ci: true };
  const tokens: Readonly<Record<string, string>> = { 'tok-good': 'fp-1' };

  const connections = startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      ackSession: () => true,
      hasListedPrincipal: (principal) => listed[principal] ?? false,
    }),
    {
      verifyHandshake: (presented) => Promise.resolve(tokens[presented ?? ''] ?? null),
      recordFailure: () => {},
      recordRefusedPrincipal: () => {},
    },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test', { token: 'tok-good', principal: 'ci' });

  const answer = await client.sendRequest('session.ack', { session: 's-1' }, 'ci');

  connections[0]?.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-gone' });

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionRemoved', sessionID: 's-gone' }]);
  });

  expect(answer).toStrictEqual({});
});

test('it keeps a TCP peer client whose handshake gave no principal subscribed, and serves its requests', async () => {
  const ctx = setupTest();
  const listed: Readonly<Record<string, boolean>> = { ci: true };
  const tokens: Readonly<Record<string, string>> = { 'tok-good': 'fp-1' };

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      ackSession: () => true,
      hasListedPrincipal: (principal) => listed[principal] ?? false,
    }),
    {
      verifyHandshake: (presented) => Promise.resolve(tokens[presented ?? ''] ?? null),
      recordFailure: () => {},
      recordRefusedPrincipal: () => {},
    },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test', { token: 'tok-good' });

  const answer = await client.sendRequest('session.ack', { session: 's-1' }, 'ci');

  expect(answer).toStrictEqual({});
  expect(client.isClosed()).toBeFalse();
});

test.each([
  [
    'a token that does not check out',
    { token: 'tok-wrong', principal: 'ci' },
    'daemon.hello over TCP needs a valid bearer token',
  ],
  ['no token', { principal: 'ci' }, 'daemon.hello over TCP needs a valid bearer token'],
  [
    'a principal the config does not list',
    { token: 'tok-good', principal: 'intruder' },
    "principal 'intruder' is not listed in principals",
  ],
])('it refuses a TCP peer handshake with %s', async (_label, hello, message) => {
  const ctx = setupTest();
  const listed: Readonly<Record<string, boolean>> = { ci: true };
  const tokens: Readonly<Record<string, string>> = { 'tok-good': 'fp-1' };

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({ hasListedPrincipal: (principal) => listed[principal] ?? false }),
    {
      verifyHandshake: (presented) => Promise.resolve(tokens[presented ?? ''] ?? null),
      recordFailure: () => {},
      recordRefusedPrincipal: () => {},
    },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test', hello)).rejects.toMatchObject({
    code: 'unauthorized',
    message,
  });
});

test.each([
  {
    label: 'no principal',
    method: 'session.ack',
    params: { session: 's-1' },
    as: undefined,
    message: 'a request over TCP must act as a principal with as',
  },
  {
    label: 'a principal the config does not list',
    method: 'session.ack',
    params: { session: 's-1' },
    as: 'intruder',
    message: "principal 'intruder' is not listed in principals",
  },
  {
    label: 'an owner-only procedure',
    method: 'daemon.quit',
    params: {},
    as: 'ci',
    message: "daemon.quit is open to the daemon's owner only",
  },
])('it refuses a TCP peer request that acts as $label', async (row) => {
  const ctx = setupTest();
  const listed: Readonly<Record<string, boolean>> = { ci: true };
  const tokens: Readonly<Record<string, string>> = { 'tok-good': 'fp-1' };

  startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({ hasListedPrincipal: (principal) => listed[principal] ?? false }),
    {
      verifyHandshake: (presented) => Promise.resolve(tokens[presented ?? ''] ?? null),
      recordFailure: () => {},
      recordRefusedPrincipal: () => {},
    },
  );

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test', { token: 'tok-good', principal: 'ci' });

  expect(client.sendRequest(row.method, row.params, row.as)).rejects.toMatchObject({
    code: 'unauthorized',
    message: row.message,
  });
});

test('it closes a peer client whose event handler throws, with the reason', async () => {
  const ctx = setupTest();
  const connections = startConnectionListener(ctx.socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  client.onEvent = () => {
    throw new Error('the screen is gone');
  };

  await client.sendHello('atc/test');

  connections[0]?.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-gone' });

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'the event subscription failed: the screen is gone',
  });
});

test('it holds a peer subscription back while the socket takes nothing, then reports the output it dropped', async () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 512,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 3, data: 'c'.repeat(300) },
    300,
  );

  peer.setAccepting(true);
  conn.drain();

  await waitFor(() => {
    expect(resyncs).toStrictEqual([toSessionID('s1')]);
  });

  expect(JSON.stringify(peer.collectFrames())).toInclude('"ev":"SessionDesync"');
  expect(peer.hasEnded()).toBeFalse();
});

test('it delivers output again after the dropped output is reported', async () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 512,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 3, data: 'c'.repeat(300) },
    300,
  );

  peer.setAccepting(true);
  conn.drain();

  await waitFor(() => {
    expect(resyncs).toStrictEqual([toSessionID('s1')]);
  });

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 4, data: 'z'.repeat(300) },
    300,
  );

  await waitFor(() => {
    expect(JSON.stringify(peer.collectFrames())).toInclude('z'.repeat(300));
  });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('c'.repeat(300));
});

test('it reports no dropped output while the socket still takes nothing', async () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 512,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 3, data: 'c'.repeat(300) },
    300,
  );

  await waitFor(() => {
    expect(peer.countRefusedWrites()).toBeGreaterThan(0);
  });

  conn.drain();

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('SessionDesync');
  expect(resyncs).toStrictEqual([]);
  expect(peer.hasEnded()).toBeFalse();
});

test('it sends a principal no output of a session whose tree left its view, a resync included', async () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];
  let visible = true;

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 512,
      canSeeSession: () => visible,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V, principal: 'narrow' };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.sendEvent({
    version: PROTOCOL_V,
    ev: 'SessionResized',
    sessionID: 's1',
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(JSON.stringify(peer.collectFrames())).toInclude('SessionResized');
  });

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 1, data: 'a'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 2, data: 'b'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { version: PROTOCOL_V, ev: 'SessionOutput', sessionID: 's1', seq: 3, data: 'c'.repeat(300) },
    300,
  );

  visible = false;

  conn.sendEvent({
    version: PROTOCOL_V,
    ev: 'SessionResized',
    sessionID: 's1',
    cols: 80,
    rows: 24,
  });

  conn.sendOutput(
    toSessionID('s1'),
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: 's1',
      seq: 4,
      data: 'secret'.repeat(40),
    },
    240,
  );

  peer.setAccepting(true);
  conn.drain();

  await waitFor(() => {
    expect(JSON.stringify(peer.collectFrames())).toInclude('SessionRemoved');
  });

  conn.sendOutput(
    toSessionID('s1'),
    {
      version: PROTOCOL_V,
      ev: 'SessionOutput',
      sessionID: 's1',
      seq: 5,
      data: 'secret'.repeat(40),
    },
    240,
  );

  conn.drain();

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('secret');
  expect(JSON.stringify(peer.collectFrames())).not.toInclude('SessionDesync');
  expect(resyncs).toStrictEqual([]);
});

test('it answers internal when a procedure returns an answer outside its contract', async () => {
  const peer = buildStubPeerSocket();

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ writeStateBackup: () => Promise.resolve(Number.NaN) }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/daemon/backup', { path: '/backup.db' }),
  );

  const refusal: unknown = expect.objectContaining({
    code: 'internal',
    message: expect.toStartWith('Output validation failed: '),
  });

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '2', body: refusal }),
    );
  });
});

test.each([
  ['an answer', '/daemon/ping'],
  ['an error answer', '/no/such/method'],
])('it ends the connection when %s overflows the outbound queue', async (_label, path) => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext({ queueBytes: 16 }));
  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  peer.setAccepting(false);
  conn.applyChunk(buildPeerRequestLine('2', path, {}) + buildPeerRequestLine('3', path, {}));

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });
});

test('it ends a connection that sends a line-protocol request, without an answer', () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.applyChunk('{"v":5,"id":1,"m":"daemon.hello","p":{"client":"atc/old"}}\n');

  expect(peer.hasEnded()).toBeTrue();
  expect(peer.collectFrames()).toStrictEqual([]);
});

test('it records a line-protocol request before a TCP handshake as an unexpected line', () => {
  const peer = buildStubPeerSocket();
  const recordFailure = mock(() => {});

  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext(), {
    verifyHandshake: () => Promise.resolve('fp-1'),
    recordFailure,
    recordRefusedPrincipal: () => {},
  });

  conn.applyChunk('{"v":5,"id":1,"m":"daemon.hello","p":{"client":"atc/old"}}\n');

  expect(recordFailure).toHaveBeenCalledExactlyOnceWith('unexpected_line');
  expect(peer.hasEnded()).toBeTrue();
  expect(peer.collectFrames()).toStrictEqual([]);
});

test('it ends a connection that sends a line over the size cap, without an answer', () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.applyChunk('x'.repeat(MAX_LINE + 1));

  expect(peer.hasEnded()).toBeTrue();
  expect(peer.collectFrames()).toStrictEqual([]);
});

test('it records a line over the size cap before a TCP handshake as too long', () => {
  const peer = buildStubPeerSocket();
  const recordFailure = mock(() => {});

  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext(), {
    verifyHandshake: () => Promise.resolve('fp-1'),
    recordFailure,
    recordRefusedPrincipal: () => {},
  });

  conn.applyChunk('x'.repeat(MAX_LINE + 1));

  expect(recordFailure).toHaveBeenCalledExactlyOnceWith('line_too_long');
  expect(peer.hasEnded()).toBeTrue();
});

test.each([
  {
    label: 'a handshake',
    path: '/daemon/hello',
    body: { client: 'atc/test', protocol: PROTOCOL_V },
    answer: { daemon: 'atc/test' },
    ends: false,
  },
  {
    label: 'a request',
    path: '/daemon/ping',
    body: {},
    answer: { code: 'unauthorized', message: 'daemon.hello must be the first request' },
    ends: true,
  },
  {
    label: 'a path that names no procedure',
    path: '/daemon/ping/',
    body: {},
    answer: { code: 'unknown_method' },
    ends: true,
  },
])('it answers $label on a peer connection that awaits its handshake', async (row) => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.applyChunk(buildPeerRequestLine('9', row.path, row.body));

  const expected: unknown = expect.objectContaining(row.answer);

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '9', body: expected }),
    );
  });

  await waitFor(() => {
    expect(peer.hasEnded()).toBe(row.ends);
  });
});

test('it drops an event sent to a peer connection that awaits its handshake', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-early' });

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-late' });

  await waitFor(() => {
    expect(JSON.stringify(peer.collectFrames())).toInclude('s-late');
  });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('s-early');
});

test('it ends a peer connection disposed while it awaits its handshake, and answers nothing after', () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.dispose();

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  expect(peer.hasEnded()).toBeTrue();
  expect(peer.collectFrames()).toStrictEqual([]);
});

test('it refuses a second handshake at once while the first is pending, and keeps the connection', async () => {
  const peer = buildStubPeerSocket();
  const held = Promise.withResolvers<string>();
  const load = mock(() => held.promise);

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ loadLastUsedAgent: load }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(load).toHaveBeenCalledOnce();
  });

  conn.applyChunk(buildPeerRequestLine('9', '/daemon/hello', hello));

  const refusal: unknown = expect.objectContaining({
    code: 'unauthorized',
    message: 'a connection takes one handshake',
  });

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '9', body: refusal }),
    );
  });

  held.resolve('claude');

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  expect(peer.hasEnded()).toBeFalse();
});

test('it holds a peer request back until a pending handshake passes', async () => {
  const peer = buildStubPeerSocket();
  const held = Promise.withResolvers<string>();
  const load = mock(() => held.promise);
  const ack = mock(() => true);

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ loadLastUsedAgent: load, ackSession: ack }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(load).toHaveBeenCalledOnce();
  });

  // The second handshake is refused at once, so its answer shows the
  // request before it was read and held.
  conn.applyChunk(
    buildPeerRequestLine('9', '/session/ack', { session: 's-1' }) +
      buildPeerRequestLine('8', '/daemon/hello', hello),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('8');
  });

  const heldFrames = peer.collectFrames().map((frame) => frame.id);
  const heldAcks = ack.mock.calls.length;

  held.resolve('claude');

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toIncludeAllMembers(['1', '9']);
  });

  expect(heldFrames).toStrictEqual(['8']);
  expect(heldAcks).toBe(0);
  expect(ack).toHaveBeenCalledExactlyOnceWith(toSessionID('s-1'));
});

test('it answers a path that names no procedure while the handshake is pending, and keeps the connection', async () => {
  const peer = buildStubPeerSocket();
  const held = Promise.withResolvers<string>();
  const load = mock(() => held.promise);

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ loadLastUsedAgent: load }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(load).toHaveBeenCalledOnce();
  });

  conn.applyChunk(buildPeerRequestLine('9', '/daemon/ping/', {}));

  const refusal: unknown = expect.objectContaining({ code: 'unknown_method' });

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '9', body: refusal }),
    );
  });

  held.resolve('claude');

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  expect(peer.hasEnded()).toBeFalse();
});

test('it drops an event sent to a peer connection while its handshake is pending', async () => {
  const peer = buildStubPeerSocket();
  const held = Promise.withResolvers<string>();
  const load = mock(() => held.promise);

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ loadLastUsedAgent: load }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(load).toHaveBeenCalledOnce();
  });

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-early' });
  held.resolve('claude');

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-late' });

  await waitFor(() => {
    expect(JSON.stringify(peer.collectFrames())).toInclude('s-late');
  });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('s-early');
});

test('it ends a peer connection disposed while its handshake is pending', async () => {
  const peer = buildStubPeerSocket();
  const held = Promise.withResolvers<string>();
  const load = mock(() => held.promise);

  const conn = createDaemonConnection(
    peer.socket,
    buildStubDaemonContext({ loadLastUsedAgent: load }),
  );

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(load).toHaveBeenCalledOnce();
  });

  conn.dispose();

  expect(peer.hasEnded()).toBeTrue();
});

test.each([
  [
    'a handshake',
    '/daemon/hello',
    { client: 'atc/test', protocol: PROTOCOL_V },
    { code: 'unauthorized', message: 'a connection takes one handshake' },
  ],
  ['a request', '/daemon/ping', {}, {}],
  ['a path that names no procedure', '/daemon/ping/', {}, { code: 'unknown_method' }],
])('it answers %s on an open peer connection and keeps it', async (_label, path, body, answer) => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.applyChunk(buildPeerRequestLine('9', path, body));

  const expected: unknown = expect.objectContaining(answer);

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '9', body: expected }),
    );
  });

  expect(peer.hasEnded()).toBeFalse();
});

test('it ends an open peer connection once disposed, and answers nothing after', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.dispose();
  conn.applyChunk(buildPeerRequestLine('9', '/daemon/ping', {}));

  expect(peer.hasEnded()).toBeTrue();
  expect(peer.collectFrames().map((frame) => frame.id)).toStrictEqual(['1']);
});

test('it writes a refused handshake whole before it ends the connection', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  peer.setAccepting(false);
  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.countRefusedWrites()).toBeGreaterThan(0);
  });

  const endedWhileQueued = peer.hasEnded();

  peer.setAccepting(true);
  conn.drain();

  const refusal: unknown = expect.objectContaining({ code: 'protocol_mismatch' });

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  expect(endedWhileQueued).toBeFalse();

  expect<unknown[]>(peer.collectFrames()).toStrictEqual([
    expect.objectContaining({ id: '1', body: refusal }),
  ]);
});

test.each([
  [
    'a handshake',
    '/daemon/hello',
    { client: 'atc/test', protocol: PROTOCOL_V },
    { code: 'unauthorized', message: 'a connection takes one handshake' },
  ],
  ['a request', '/daemon/ping', {}, { code: 'unauthorized', message: 'the handshake was refused' }],
  ['a path that names no procedure', '/daemon/ping/', {}, { code: 'unknown_method' }],
])(
  'it answers %s sent behind a refused handshake, then ends the connection once both are written',
  async (_label, path, body, answer) => {
    const peer = buildStubPeerSocket();
    const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
    const hello = { client: 'atc/old', protocol: 1 };

    peer.setAccepting(false);

    conn.applyChunk(
      buildPeerRequestLine('1', '/daemon/hello', hello) + buildPeerRequestLine('9', path, body),
    );

    await waitFor(() => {
      expect(peer.countRefusedWrites()).toBeGreaterThan(0);
    });

    const endedWhileQueued = peer.hasEnded();

    peer.setAccepting(true);
    conn.drain();

    const expected: unknown = expect.objectContaining(answer);

    await waitFor(() => {
      expect<unknown[]>(peer.collectFrames()).toContainEqual(
        expect.objectContaining({ id: '9', body: expected }),
      );
    });

    await waitFor(() => {
      expect(peer.hasEnded()).toBeTrue();
    });

    expect(endedWhileQueued).toBeFalse();
  },
);

test('it writes no event to a peer connection whose refusal is still queued', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  peer.setAccepting(false);
  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.countRefusedWrites()).toBeGreaterThan(0);
  });

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-refused' });
  peer.setAccepting(true);
  conn.drain();

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('s-refused');
});

test('it ends a peer connection disposed while its refusal is still queued', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  peer.setAccepting(false);
  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.countRefusedWrites()).toBeGreaterThan(0);
  });

  conn.dispose();

  expect(peer.hasEnded()).toBeTrue();
});

test.each([
  [
    'a handshake',
    '/daemon/hello',
    { client: 'atc/test', protocol: PROTOCOL_V },
    { code: 'unauthorized', message: 'a connection takes one handshake' },
  ],
  ['a request', '/daemon/ping', {}, { code: 'unauthorized', message: 'the connection is closing' }],
  ['a path that names no procedure', '/daemon/ping/', {}, { code: 'unknown_method' }],
])('it answers %s on a peer connection that is closing', async (_label, path, body, answer) => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  conn.applyChunk(buildPeerRequestLine('9', path, body));

  const expected: unknown = expect.objectContaining(answer);

  await waitFor(() => {
    expect<unknown[]>(peer.collectFrames()).toContainEqual(
      expect.objectContaining({ id: '9', body: expected }),
    );
  });
});

test('it writes no event to a peer connection that is closing', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-closing' });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('s-closing');
});

test('it answers nothing on a closing peer connection once disposed', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/old', protocol: 1 };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  conn.dispose();
  conn.applyChunk(buildPeerRequestLine('9', '/daemon/ping', {}));

  expect(peer.collectFrames().map((frame) => frame.id)).toStrictEqual(['1']);
});

test.each([
  ['a handshake', '/daemon/hello', { client: 'atc/test', protocol: PROTOCOL_V }],
  ['a request', '/daemon/ping', {}],
  ['a path that names no procedure', '/daemon/ping/', {}],
])('it answers nothing to %s on a closed peer connection', async (_label, path, body) => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.dispose();
  conn.applyChunk(buildPeerRequestLine('9', path, body));

  expect(peer.collectFrames().map((frame) => frame.id)).toStrictEqual(['1']);
});

test('it writes no event to a closed peer connection', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/test', protocol: PROTOCOL_V };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/events/subscribe', {}),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('1');
  });

  conn.dispose();
  conn.sendEvent({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-closed' });

  expect(JSON.stringify(peer.collectFrames())).not.toInclude('s-closed');
});

test('it takes a second dispose of a closed peer connection as a no-op', () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());

  conn.dispose();

  expect(() => {
    conn.dispose();
  }).not.toThrow();
});

// xstate warns of an event sent to a stopped actor only in its development
// build, which a run under the development condition loads.
test('it sends a closed peer connection disposed again no event, so xstate warns of none', async () => {
  const script = [
    `import { createDaemonConnection } from '${join(import.meta.dir, 'create-daemon-connection.ts')}';`,
    `import { buildStubDaemonContext } from '${join(import.meta.dir, '..', 'testing', 'build-stub-daemon-context.ts')}';`,
    'const socket = { write: (data) => data.length, end: () => {} };',
    'const conn = createDaemonConnection(socket, buildStubDaemonContext());',
    'conn.dispose();',
    'conn.dispose();',
  ].join('\n');

  const run = await runCommand([process.execPath, '--conditions', 'development', '-e', script], {
    cwd: import.meta.dir,
  });

  expect({ exitCode: run.exitCode, stderr: run.stderr }).toStrictEqual({ exitCode: 0, stderr: '' });
});

test('it refuses a peer handshake that gives another session than the one the kernel names, and ends the connection', async () => {
  const peer = buildStubPeerSocket();

  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext(), null, {
    id: toSessionID('s-1'),
  });

  const hello = { client: 'atc/test', protocol: PROTOCOL_V, session: 's-2' };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  const refusal: unknown = expect.objectContaining({
    code: 'unauthorized',
    message:
      "daemon.hello gives session 's-2', but the connecting process runs inside session 's-1'",
  });

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });

  expect<unknown[]>(peer.collectFrames()).toStrictEqual([
    expect.objectContaining({ id: '1', body: refusal }),
  ]);
});

test('it acts as the session the kernel names for a peer handshake that gives none', async () => {
  const peer = buildStubPeerSocket();
  const isCallerTree = mock<DaemonContext['isCallerTree']>(() => true);

  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext({ isCallerTree }), null, {
    id: toSessionID('s-1'),
  });

  const hello = { client: 'atc/test', protocol: PROTOCOL_V };
  const add = { session: 's-6', scope: { worktrees: [{ path: '/srv/site' }] } };

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', hello) +
      buildPeerRequestLine('2', '/session/scope/add', add),
  );

  await waitFor(() => {
    expect(peer.collectFrames().map((frame) => frame.id)).toContain('2');
  });

  expect(isCallerTree).toHaveBeenCalledExactlyOnceWith(toSessionID('s-6'), toSessionID('s-1'));
});

test('it answers a peer handshake with the session the kernel names as its peer session', async () => {
  const peer = buildStubPeerSocket();

  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext(), null, {
    id: toSessionID('s-1'),
  });

  conn.applyChunk(
    buildPeerRequestLine('1', '/daemon/hello', { client: 'atc/test', protocol: PROTOCOL_V }),
  );

  await waitFor(() => {
    expect(peer.collectFrames()).toHaveLength(1);
  });

  expect<unknown[]>(peer.collectFrames()).toStrictEqual([
    expect.objectContaining({
      id: '1',
      body: {
        daemon: 'atc/test',
        daemonID: 'd-1',
        limits: { maxLine: MAX_LINE, maxChunk: 65_536 },
        idempotency: { completedRetentionMs: 86_400_000 },
        lastUsedAgent: 'claude',
        peerSession: 's-1',
        features: ['events.read.from-start'],
      },
    }),
  ]);
});

test('it answers a peer handshake that gives a session, from outside every session, with no peer session', async () => {
  const peer = buildStubPeerSocket();
  const conn = createDaemonConnection(peer.socket, buildStubDaemonContext());
  const hello = { client: 'atc/test', protocol: PROTOCOL_V, session: 's-9' };

  conn.applyChunk(buildPeerRequestLine('1', '/daemon/hello', hello));

  await waitFor(() => {
    expect(peer.collectFrames()).toHaveLength(1);
  });

  expect<unknown[]>(peer.collectFrames()).toStrictEqual([
    expect.objectContaining({ id: '1', body: expect.objectContaining({ peerSession: null }) }),
  ]);
});
