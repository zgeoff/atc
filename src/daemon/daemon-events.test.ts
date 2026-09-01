import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseEventLine } from '../../test/parse-event-line';
import { setupTempDir } from '../../test/setup-temp-dir';
import { spawnNamedSession } from '../../test/spawn-named-session';
import { subscribeToSocketLines } from '../../test/subscribe-to-socket-lines';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from './daemon';

// Events-socket tests: snapshot-then-stream and read-only behavior. The
// overflow disconnect lives in start-events-server.test.ts, and protocol
// behavior in daemon.test.ts.
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
  readonly eventsPath: string;
  readonly actor: DaemonClient;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

async function setupTest(): Promise<EventsDaemon> {
  const tmp = setupTempDir('atc-events-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const eventsPath = join(tmp.dir, 'events.sock');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    eventsSocketPath: eventsPath,
    build: 'atc/test-build',
    adapter: idleAdapter,
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const actor = await DaemonClient.open(sockPath);

  await actor.sendHello('atc/test-build');

  return {
    eventsPath,
    actor,
    [Symbol.asyncDispose]: async () => {
      actor.stop();

      await daemon.stop();
      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it replays the fleet as SessionAdded lines on connect, then streams live events', async () => {
  await using setup = await setupTest();

  const firstID = await spawnNamedSession((m, p) => setup.actor.sendRequest(m, p), 'one', '/tmp');

  await spawnNamedSession((m, p) => setup.actor.sendRequest(m, p), 'two', '/tmp');

  await using subscriber = await subscribeToSocketLines(setup.eventsPath);

  const initial = await subscriber.waitForLine(2);

  const snapshot = initial.slice(0, 2).map((line) => parseEventLine(line));

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

  await setup.actor.sendRequest('session.update', { session: firstID, name: 'renamed-one' });

  const afterRename = await subscriber.waitForLine(3);

  const renamed = afterRename
    .map((line) => parseEventLine(line))
    .find((e) => e.ev === 'SessionRenamed');

  expect(renamed).toMatchObject({ v: 3, ev: 'SessionRenamed', s: firstID, name: 'renamed-one' });
});

test('it ignores subscriber input and keeps streaming', async () => {
  await using setup = await setupTest();
  await using subscriber = await subscribeToSocketLines(setup.eventsPath);

  subscriber.write('{"m":"session.kill"}\nnot even json\n');

  await spawnNamedSession((m, p) => setup.actor.sendRequest(m, p), 'after-garbage', '/tmp');

  const streamed = await subscriber.waitForLine(1);

  const added = streamed.map((line) => parseEventLine(line));

  expect(added[0]).toMatchObject({
    v: 3,
    ev: 'SessionAdded',
    session: { name: 'after-garbage' },
  });
});
