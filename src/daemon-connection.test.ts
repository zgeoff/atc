import { expect, test } from 'bun:test';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext } from './daemon-connection';
import { PROTOCOL_V } from './protocol';
import type { EventMsg } from './protocol';

function assertUnreachable(): never {
  throw new Error('unreachable in this test');
}

interface ConnectionHarness {
  readonly conn: DaemonConnection;
  readonly resyncs: string[];
  readonly collectWrittenLines: () => string[];
  readonly setAccepting: (accepting: boolean) => void;
}

/**
 * A connection whose peer socket accepts bytes only while `accepting` is
 * true, so backpressure is a switch instead of a kernel-buffer race.
 */
function setupConnection(queueBytes: number): ConnectionHarness {
  let accepting = true;
  let written = '';
  const resyncs: string[] = [];

  const decoder = new TextDecoder();

  const peer = {
    // oxlint-disable-next-line prefer-readonly-parameter-types -- a readonly view cannot satisfy the writer contract; the fake never mutates chunks
    write: (data: Uint8Array): number => {
      if (!accepting) {
        return 0;
      }

      written += decoder.decode(data);

      return data.length;
    },
    end: () => {},
  };

  const ctx: DaemonContext = {
    build: 'atc/test',
    collectSessions: () => [],
    collectSpawnDirs: assertUnreachable,
    collectFleet: assertUnreachable,
    loadLastUsedAgent: () => 'claude',
    findAdapter: assertUnreachable,
    spawnSession: assertUnreachable,
    killSession: assertUnreachable,
    updateSession: assertUnreachable,
    quitDaemon: assertUnreachable,
    ackSession: assertUnreachable,
    buildResumeCommand: assertUnreachable,
    answerPermission: assertUnreachable,
    restoreFleet: assertUnreachable,
    attachSession: assertUnreachable,
    detachSession: assertUnreachable,
    detachClient: assertUnreachable,
    writeSessionInput: assertUnreachable,
    ejectSession: assertUnreachable,
    adoptSession: assertUnreachable,
    resizeSession: assertUnreachable,
    resyncClient: (sessionID: string) => {
      resyncs.push(sessionID);

      return Promise.resolve();
    },
    queueBytes,
    getEffectiveDims: assertUnreachable,
  };

  const conn = new DaemonConnection(peer, ctx);

  conn.applyChunk('{"v":2,"id":1,"m":"daemon.hello","p":{"client":"atc/test"}}\n');

  return {
    conn,
    resyncs,
    collectWrittenLines: () => written.split('\n').filter((line) => line !== ''),
    setAccepting: (value: boolean) => {
      accepting = value;
    },
  };
}

function buildOutputEvent(marker: string): EventMsg {
  return { v: PROTOCOL_V, ev: 'session.output', s: 's1', d: marker.repeat(40) };
}

test('it drops an overflowing session backlog and reports the dropped bytes on drain', () => {
  const harness = setupConnection(64);

  harness.setAccepting(false);
  harness.conn.sendOutput('s1', buildOutputEvent('a'), 40);
  harness.conn.sendOutput('s1', buildOutputEvent('b'), 100);
  harness.conn.sendOutput('s1', buildOutputEvent('c'), 50);
  harness.setAccepting(true);
  harness.conn.drain();

  const lines = harness.collectWrittenLines();

  expect(lines.find((line) => line.includes('a'.repeat(40)))).toBeDefined();
  expect(lines.find((line) => line.includes('b'.repeat(40)))).toBeUndefined();
  expect(lines.find((line) => line.includes('c'.repeat(40)))).toBeUndefined();

  const desyncLine = lines.find((line) => line.includes('session.desync'));

  if (desyncLine === undefined) {
    throw new Error('no session.desync line was written');
  }

  expect(JSON.parse(desyncLine)).toStrictEqual({
    v: PROTOCOL_V,
    ev: 'session.desync',
    s: 's1',
    dropped: 150,
  });

  expect(harness.resyncs).toStrictEqual(['s1']);
});

test('it delivers output again after the desync is reported', () => {
  const harness = setupConnection(64);

  harness.setAccepting(false);
  harness.conn.sendOutput('s1', buildOutputEvent('a'), 40);
  harness.conn.sendOutput('s1', buildOutputEvent('b'), 100);
  harness.setAccepting(true);
  harness.conn.drain();
  harness.conn.sendOutput('s1', buildOutputEvent('z'), 40);

  const lines = harness.collectWrittenLines();

  expect(lines.at(-1)).toInclude('z'.repeat(40));
  expect(harness.resyncs).toStrictEqual(['s1']);
});

test('it reports no desync while the queue still holds a backlog', () => {
  const harness = setupConnection(64);

  harness.setAccepting(false);
  harness.conn.sendOutput('s1', buildOutputEvent('a'), 40);
  harness.conn.sendOutput('s1', buildOutputEvent('b'), 100);
  harness.conn.drain();

  expect(
    harness.collectWrittenLines().find((line) => line.includes('session.desync')),
  ).toBeUndefined();

  expect(harness.resyncs).toStrictEqual([]);
});
