import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import type { DaemonEvent } from '@atc/protocol';
import { DaemonClient } from '@atc/protocol/client';
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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

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
