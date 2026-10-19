import { expect, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import type { DaemonEvent } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildStubPeerSocket, setupTempDir, waitFor } from '@atc/test-utils';
import { TargetAccess } from '../auth/target-access';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { startConnectionListener } from '../testing/start-connection-listener';
import { DaemonConnection } from './daemon-connection';

function setupTest() {
  const tmp = setupTempDir('atc-daemon-connection-');

  return { socketPath: join(tmp.dir, 'daemon.sock') };
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
      'atc/old speaks protocol v1, daemon atc/test speaks v4; restart the daemon so both run the same build',
  });

  await refused.catch(() => {});

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
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

  connections[0]?.sendEvent({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-gone' });

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionRemoved', s: 's-gone' }]);
  });
});

test('it delivers a peer client that acts as a principal no event of a session out of its reach', async () => {
  const ctx = setupTest();

  const connections = startConnectionListener(
    ctx.socketPath,
    buildStubDaemonContext({
      buildTargetAccess: () => new TargetAccess([]),
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
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-hidden', seq: 1, d: 'secret' },
    6,
  );

  connections[0]?.sendOutput(
    toSessionID('s-seen'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's-seen', seq: 1, d: 'shown' },
    5,
  );

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionOutput', s: 's-seen', seq: 1, d: 'shown' }]);
  });
});

test.each([
  ['the handshake', 'daemon.quit', {}, { principal: 'narrow' }, undefined],
  ['the handshake', 'daemon.backup', { path: '/backup.db' }, { principal: 'narrow' }, undefined],
  ['a request header', 'daemon.quit', {}, {}, 'narrow'],
  ['a request header', 'daemon.backup', { path: '/backup.db' }, {}, 'narrow'],
])(
  'it refuses a principal given in %s the owner-only %s',
  async (_label, method, params, hello, as) => {
    const ctx = setupTest();

    startConnectionListener(ctx.socketPath, buildStubDaemonContext());

    const client = await openDaemonClient(ctx.socketPath);

    onTestFinished(() => {
      client.stop();
    });

    await client.sendHello('atc/test', hello);

    expect(client.sendRequest(method, params, as)).rejects.toMatchObject({
      code: 'unauthorized',
      message: `${method} is open to the daemon's owner only`,
    });
  },
);

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

    const lines: unknown[] = [];

    const raw = await Bun.connect({
      unix: ctx.socketPath,
      socket: {
        data(_socket, buf) {
          const written = buf.toString().split('\n').filter(Boolean);

          lines.push(...written.map((line): unknown => JSON.parse(line)));
        },
      },
    });

    onTestFinished(() => {
      raw.end();
    });

    const hello = { client: 'atc/test', protocol: PROTOCOL_V, principal: 'narrow' };

    raw.write(
      `${JSON.stringify({ i: '1', p: { u: '/daemon/hello', b: { json: hello } } })}\n${JSON.stringify({ i: '2', p: { u: path, b: { json: {} } } })}\n`,
    );

    const refusal: unknown = expect.objectContaining({ code });
    const response: unknown = expect.objectContaining({ b: { json: refusal } });

    await waitFor(() => {
      expect(lines).toContainEqual(expect.objectContaining({ i: '2', p: response }));
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

  connections[0]?.sendEvent({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-gone' });

  await waitFor(() => {
    expect(events).toStrictEqual([{ ev: 'SessionRemoved', s: 's-gone' }]);
  });

  expect(answer).toStrictEqual({});
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
  [
    'no principal',
    'session.ack',
    { session: 's-1' },
    undefined,
    'a request over TCP must act as a principal with as',
  ],
  [
    'a principal the config does not list',
    'session.ack',
    { session: 's-1' },
    'intruder',
    "principal 'intruder' is not listed in principals",
  ],
  [
    'an owner-only procedure',
    'daemon.quit',
    {},
    'ci',
    "daemon.quit is open to the daemon's owner only",
  ],
])('it refuses a TCP peer request that acts as %s', async (_label, method, params, as, message) => {
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

  expect(client.sendRequest(method, params, as)).rejects.toMatchObject({
    code: 'unauthorized',
    message,
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

  connections[0]?.sendEvent({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's-gone' });

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

  const conn = new DaemonConnection(
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
    `${JSON.stringify({ i: '1', p: { u: '/daemon/hello', b: { json: hello } } })}\n${JSON.stringify({ i: '2', p: { u: '/events/subscribe', b: { json: {} } } })}\n`,
  );

  await waitFor(() => {
    expect(peer.collectFrames()).toContainEqual(expect.objectContaining({ i: '1' }));
  });

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 1, d: 'a'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 2, d: 'b'.repeat(300) },
    300,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', seq: 3, d: 'c'.repeat(300) },
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

test('it drops an overflowing session backlog and reports the dropped bytes on drain', () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = new DaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 64,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n`,
  );

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'a'.repeat(40) },
    40,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'b'.repeat(40) },
    100,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'c'.repeat(40) },
    50,
  );

  peer.setAccepting(true);
  conn.drain();

  expect(peer.collectFrames()).toStrictEqual([
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'a'.repeat(40) },
    { v: PROTOCOL_V, ev: 'SessionDesync', s: 's1', dropped: 150 },
  ]);

  expect(resyncs).toStrictEqual([toSessionID('s1')]);
});

test('it delivers output again after the desync is reported', () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = new DaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 64,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n`,
  );

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'a'.repeat(40) },
    40,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'b'.repeat(40) },
    100,
  );

  peer.setAccepting(true);
  conn.drain();

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'z'.repeat(40) },
    40,
  );

  expect(peer.collectFrames().at(-1)).toStrictEqual({
    v: PROTOCOL_V,
    ev: 'SessionOutput',
    s: 's1',
    d: 'z'.repeat(40),
  });

  expect(resyncs).toStrictEqual([toSessionID('s1')]);
});

test('it reports no desync while the queue still holds a backlog', () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];

  const conn = new DaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 64,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n`,
  );

  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'a'.repeat(40) },
    40,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'b'.repeat(40) },
    100,
  );

  conn.drain();

  expect(peer.collectFrames()).toStrictEqual([]);
  expect(resyncs).toStrictEqual([]);
});

test('it sends a principal no output of a session whose tree left its view, a resync included', () => {
  const peer = buildStubPeerSocket();
  const resyncs: SessionID[] = [];
  let visible = true;

  const conn = new DaemonConnection(
    peer.socket,
    buildStubDaemonContext({
      queueBytes: 150,
      canSeeSession: () => visible,
      resyncClient: (sessionID) => {
        resyncs.push(sessionID);

        return Promise.resolve();
      },
    }),
  );

  conn.applyChunk(
    `${JSON.stringify({
      v: PROTOCOL_V,
      id: 1,
      m: 'daemon.hello',
      p: { client: 'atc/test', principal: 'narrow' },
    })}\n`,
  );

  conn.sendEvent({ v: PROTOCOL_V, ev: 'SessionState', s: 's1' });
  peer.setAccepting(false);

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'a'.repeat(40) },
    40,
  );

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'b'.repeat(40) },
    40,
  );

  visible = false;

  conn.sendEvent({ v: PROTOCOL_V, ev: 'SessionState', s: 's1' });

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'secret'.repeat(40) },
    240,
  );

  peer.setAccepting(true);
  conn.drain();

  conn.sendOutput(
    toSessionID('s1'),
    { v: PROTOCOL_V, ev: 'SessionOutput', s: 's1', d: 'secret'.repeat(40) },
    240,
  );

  conn.drain();

  const frames = peer.collectFrames();

  expect(frames.at(-1)).toStrictEqual({ v: PROTOCOL_V, ev: 'SessionRemoved', s: 's1' });
  expect(JSON.stringify(frames)).not.toInclude('secret');
  expect(resyncs).toStrictEqual([]);
});

test('it answers internal with the request id when a procedure returns an answer outside its contract', async () => {
  const peer = buildStubPeerSocket();

  const conn = new DaemonConnection(
    peer.socket,
    buildStubDaemonContext({ writeStateBackup: () => Promise.resolve(Number.NaN) }),
  );

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n${JSON.stringify({ v: PROTOCOL_V, id: 2, m: 'daemon.backup', p: { path: '/backup.db' } })}\n`,
  );

  await peer.waitForAnswer(2);

  expect(peer.collectFrames().find((frame) => frame['id'] === 2)).toStrictEqual({
    v: PROTOCOL_V,
    id: 2,
    err: { code: 'internal', msg: expect.toStartWith('Output validation failed: ') as unknown },
  });
});

test('it ends the connection when an answer overflows the outbound queue', async () => {
  const peer = buildStubPeerSocket();

  const conn = new DaemonConnection(peer.socket, buildStubDaemonContext({ queueBytes: 16 }));

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n`,
  );

  await peer.waitForAnswer(1);

  peer.setAccepting(false);

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 2, m: 'daemon.ping' })}\n${JSON.stringify({ v: PROTOCOL_V, id: 3, m: 'daemon.ping' })}\n`,
  );

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });
});

test('it ends the connection when an error answer overflows the outbound queue', async () => {
  const peer = buildStubPeerSocket();

  const conn = new DaemonConnection(peer.socket, buildStubDaemonContext({ queueBytes: 16 }));

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 1, m: 'daemon.hello', p: { client: 'atc/test' } })}\n`,
  );

  await peer.waitForAnswer(1);

  peer.setAccepting(false);

  conn.applyChunk(
    `${JSON.stringify({ v: PROTOCOL_V, id: 2, m: 'no.such.method' })}\n${JSON.stringify({ v: PROTOCOL_V, id: 3, m: 'no.such.method' })}\n`,
  );

  await waitFor(() => {
    expect(peer.hasEnded()).toBeTrue();
  });
});
