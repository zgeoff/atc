import { expect, test } from 'bun:test';
import { PROTOCOL_V } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubDaemonContext } from '../test-utils/build-stub-daemon-context';
import { buildStubPeerSocket } from '../test-utils/build-stub-peer-socket';
import { DaemonConnection } from './daemon-connection';

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
