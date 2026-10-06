import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';

interface BootOptions {
  readonly restoreFleetOnRestart?: boolean;
  readonly restoreBootTimeoutMs: number;
}

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-daemon-fleet-restart-'));

  const dbPath = join(dir, 'state.db');
  const sockPath = join(dir, 'daemon.sock');
  const stops: (() => Promise<void>)[] = [];
  const spawns = { count: 0 };

  const adapter: AgentAdapter = {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: true,
    planSpawn: () => {
      spawns.count += 1;

      return { bin: 'sleep', args: ['30'] };
    },
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  return {
    dbPath,
    spawns,
    async boot(options: BootOptions): Promise<DaemonClient> {
      const daemon = await startDaemon({
        socketPath: sockPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
        restoreBootTimeoutMs: options.restoreBootTimeoutMs,
        ...(options.restoreFleetOnRestart === undefined
          ? {}
          : { restoreFleetOnRestart: options.restoreFleetOnRestart }),
      });

      const client = await DaemonClient.open(sockPath);

      let stopped = false;

      stops.push(async () => {
        if (stopped) {
          return;
        }

        stopped = true;

        client.stop();

        await daemon.stop();
      });

      await client.sendHello('atc/test-build');

      return client;
    },
    async stopAll() {
      for (const stop of stops.toReversed()) {
        await stop();
      }

      stops.length = 0;
    },
    async [Symbol.asyncDispose]() {
      for (const stop of stops.toReversed()) {
        await stop();
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it restores the stored sessions after a restart with no client request and sends them no message', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-a'),
      agentSessionID: toAgentSessionID('a-a'),
      name: 'a',
      cwd: '/tmp',
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-b'),
      agentSessionID: toAgentSessionID('a-b'),
      name: 'b',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-a'), event: 'UserPromptSubmit', payload: { session_id: 'a-a' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const client = await daemon.boot({ restoreFleetOnRestart: true, restoreBootTimeoutMs: 10 });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed['sessions']).toMatchObject([
      { id: 's-a', alive: true },
      { id: 's-b', alive: true },
    ]);
  });

  // The fleet write for the last session follows its adoption by well under
  // this window; no signal marks the end of the stagger.
  await Bun.sleep(150);
  await daemon.stopAll();

  const store = await StateStore.open(daemon.dbPath);
  const pendingA = await store.collectPendingMessages({ atcID: toSessionID('s-a') });
  const pendingB = await store.collectPendingMessages({ atcID: toSessionID('s-b') });

  await store.stop();

  expect({ pendingA, pendingB }).toStrictEqual({ pendingA: [], pendingB: [] });
});

test('it leaves the stored sessions without a terminal until fleet.restore when the option is unset', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-a'),
      agentSessionID: toAgentSessionID('a-a'),
      name: 'a',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.stop();

  const client = await daemon.boot({ restoreBootTimeoutMs: 10 });

  // A restore of one session needs well under this window; no signal marks
  // a restore that never starts.
  await Bun.sleep(150);

  const before = await client.sendRequest('session.list');

  const spawnsBefore = daemon.spawns.count;

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const after = await client.sendRequest('session.list');

  expect({ before: before['sessions'], spawnsBefore, after: after['sessions'] }).toMatchObject({
    before: [],
    spawnsBefore: 0,
    after: [{ id: 's-a', alive: true }],
  });
});

test('it leaves the stored sessions without a terminal when the option is false', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-a'),
      agentSessionID: toAgentSessionID('a-a'),
      name: 'a',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.stop();

  const client = await daemon.boot({ restoreFleetOnRestart: false, restoreBootTimeoutMs: 10 });

  // A restore of one session needs well under this window; no signal marks
  // a restore that never starts.
  await Bun.sleep(150);

  const listed = await client.sendRequest('session.list');

  expect({ sessions: listed['sessions'], spawns: daemon.spawns.count }).toStrictEqual({
    sessions: [],
    spawns: 0,
  });
});

test('it joins a fleet.restore to the automatic restore while its stagger runs', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet(
    ['s-a', 's-b', 's-c'].map((id) => ({
      sessionID: toSessionID(id),
      agentSessionID: toAgentSessionID(`agent-${id}`),
      name: id,
      cwd: '/tmp',
      agent: 'claude',
    })),
  );

  await seed.stop();

  // The fake agent never reports it booted, so the stagger holds on each
  // session until the cap runs out.
  const client = await daemon.boot({ restoreFleetOnRestart: true, restoreBootTimeoutMs: 1000 });

  await waitFor(() => {
    expect(daemon.spawns.count).toBe(1);
  });

  const joined = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await client.sendRequest('session.list');

  const spawnsDuringStagger = daemon.spawns.count;

  // Let the stagger finish so teardown never races a queued spawn.
  await waitFor(
    () => {
      expect(daemon.spawns.count).toBe(3);
    },
    { timeoutMs: 10_000 },
  );

  expect({ joined, spawnsDuringStagger, listed: listed['sessions'] }).toMatchObject({
    joined: { restored: 3 },
    spawnsDuringStagger: 1,
    listed: [{ id: 's-a' }, { id: 's-b' }, { id: 's-c' }],
  });
});

test('it spawns nothing for a fleet.restore after the automatic restore settled', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet(
    ['s-a', 's-b'].map((id) => ({
      sessionID: toSessionID(id),
      agentSessionID: toAgentSessionID(`agent-${id}`),
      name: id,
      cwd: '/tmp',
      agent: 'claude',
    })),
  );

  await seed.stop();

  const client = await daemon.boot({ restoreFleetOnRestart: true, restoreBootTimeoutMs: 50 });

  await waitFor(() => {
    expect(daemon.spawns.count).toBe(2);
  });

  const again = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect({ again, spawns: daemon.spawns.count }).toStrictEqual({
    again: { restored: 0 },
    spawns: 2,
  });
});
