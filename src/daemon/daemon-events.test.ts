import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { decodeMessage } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import { isRecord } from '../shared/report';
import { startDaemon } from './daemon';

// Events-socket tests: snapshot-then-stream, read-only behavior, and the
// overflow disconnect. Protocol behavior lives in daemon.test.ts.
const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

interface EventsDaemon {
  readonly sockPath: string;
  readonly eventsPath: string;
}

async function setupEventsDaemon(queueBytes?: number): Promise<EventsDaemon> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-events-'));
  const sockPath = join(dir, 'daemon.sock');
  const eventsPath = join(dir, 'events.sock');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(dir, 'reporter.sock'),
    eventsSocketPath: eventsPath,
    build: 'atc/test-build',
    adapter: idleAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ...(queueBytes === undefined ? {} : { queueBytes }),
  });

  onTestFinished(async () => {
    await daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  return { sockPath, eventsPath };
}

async function setupActor(sockPath: string): Promise<DaemonClient> {
  const actor = await DaemonClient.open(sockPath);

  onTestFinished(() => {
    actor.stop();
  });

  await actor.sendHello('atc/test-build');

  return actor;
}

interface Subscriber {
  readonly lines: string[];
  readonly write: (data: string) => void;
  readonly waitForLine: (count?: number) => Promise<string[]>;
}

async function setupSubscriber(eventsPath: string): Promise<Subscriber> {
  const lines: string[] = [];
  let buffer = '';

  const socket = await Bun.connect({
    unix: eventsPath,
    socket: {
      data(_s, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    socket.end();
  });

  return {
    lines,
    write(data: string) {
      socket.write(data);
    },
    async waitForLine(count = 1) {
      const deadline = Date.now() + 5000;

      while (lines.length < count && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      if (lines.length < count) {
        throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
      }

      return lines;
    },
  };
}

type SendSpawnRequest = DaemonClient['sendRequest'];

async function spawnNamed(send: SendSpawnRequest, name: string): Promise<string> {
  const ok = await send('session.spawn', {
    cwd: '/tmp',
    name,
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  return spawned['id'];
}

function parseEvent(line: string): EventMsg {
  const decoded = decodeMessage(line);

  if (decoded.kind !== 'event') {
    throw new Error(`not an event line: ${line}`);
  }

  return decoded.msg;
}

test('it replays the fleet as SessionAdded lines on connect, then streams live events', async () => {
  const daemon = await setupEventsDaemon();
  const actor = await setupActor(daemon.sockPath);
  const firstID = await spawnNamed((m, p) => actor.sendRequest(m, p), 'one');

  await spawnNamed((m, p) => actor.sendRequest(m, p), 'two');

  const subscriber = await setupSubscriber(daemon.eventsPath);
  const initial = await subscriber.waitForLine(2);

  const snapshot = initial.slice(0, 2).map((line) => parseEvent(line));

  expect(snapshot).toMatchObject([
    {
      v: 3,
      ev: 'SessionAdded',
      session: { name: 'one', cwd: '/tmp', agent: 'claude', alive: true },
    },
    {
      v: 3,
      ev: 'SessionAdded',
      session: { name: 'two', cwd: '/tmp', agent: 'claude', alive: true },
    },
  ]);

  await actor.sendRequest('session.update', { session: firstID, name: 'renamed-one' });

  const afterRename = await subscriber.waitForLine(3);

  const renamed = afterRename
    .map((line) => parseEvent(line))
    .find((e) => e.ev === 'SessionRenamed');

  expect(renamed).toMatchObject({ v: 3, ev: 'SessionRenamed', s: firstID, name: 'renamed-one' });
});

test('it ignores subscriber input and keeps streaming', async () => {
  const daemon = await setupEventsDaemon();
  const actor = await setupActor(daemon.sockPath);
  const subscriber = await setupSubscriber(daemon.eventsPath);

  subscriber.write('{"m":"session.kill"}\nnot even json\n');

  await spawnNamed((m, p) => actor.sendRequest(m, p), 'after-garbage');

  const streamed = await subscriber.waitForLine(1);

  const added = streamed.map((line) => parseEvent(line));

  expect(added[0]).toMatchObject({
    v: 3,
    ev: 'SessionAdded',
    session: { name: 'after-garbage' },
  });
});
