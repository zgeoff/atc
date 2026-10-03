import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { isRecord } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-daemon-fleet-'));

  const dbPath = join(dir, 'state.db');
  const sockPath = join(dir, 'daemon.sock');
  const stops: (() => Promise<void>)[] = [];

  const adapter: AgentAdapter = {
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    normalizeHook: () => ({ kind: 'heartbeat' }),
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  return {
    dbPath,
    async boot(): Promise<DaemonClient> {
      const daemon = await startDaemon({
        socketPath: sockPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
      });

      const client = await DaemonClient.open(sockPath);

      stops.push(async () => {
        client.stop();

        await daemon.stop();
      });

      await client.sendHello('atc/test-build');

      return client;
    },
    async [Symbol.asyncDispose]() {
      for (const stop of stops.toReversed()) {
        await stop();
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it keeps every stored fleet row restorable when a spawn writes the fleet before the restore', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-live-a'),
      agentSessionID: toAgentSessionID('a-live-a'),
      name: 'live-a',
      cwd: '/tmp',
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-live-b'),
      agentSessionID: toAgentSessionID('a-live-b'),
      name: 'live-b',
      cwd: '/tmp',
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-exited-a'),
      agentSessionID: toAgentSessionID('a-exited-a'),
      name: 'exited-a',
      cwd: '/tmp',
      agent: 'claude',
      exited: true,
    },
    {
      sessionID: toSessionID('s-exited-b'),
      agentSessionID: toAgentSessionID('a-exited-b'),
      name: 'exited-b',
      cwd: '/tmp',
      agent: 'claude',
      exited: true,
    },
  ]);

  await seed.stop();

  const client = await daemon.boot();

  await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 4 });

  expect(listed['sessions']).toIncludeAllPartialMembers([
    { id: 's-live-a', name: 'live-a', alive: true },
    { id: 's-live-b', name: 'live-b', alive: true },
    { id: 's-exited-a', name: 'exited-a', alive: false },
    { id: 's-exited-b', name: 'exited-b', alive: false },
    { name: 'fresh', alive: true },
  ]);
});

test('it keeps every stored fleet row when a rename and a deliberate kill write the fleet before the restore', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-live-a'),
      agentSessionID: toAgentSessionID('a-live-a'),
      name: 'live-a',
      cwd: '/tmp',
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-exited-a'),
      agentSessionID: toAgentSessionID('a-exited-a'),
      name: 'exited-a',
      cwd: '/tmp',
      agent: 'claude',
      exited: true,
    },
  ]);

  await seed.stop();

  const client = await daemon.boot();

  const spawned = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    name: 'fresh',
    cols: 80,
    rows: 24,
  });

  const session = spawned['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  await client.sendRequest('session.update', { session: session['id'], name: 'renamed' });
  await client.sendRequest('session.kill', { session: session['id'] });
  await client.sendRequest('session.kill', { session: session['id'] });

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 2 });

  expect(listed['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: 's-live-a', name: 'live-a', alive: true }),
    expect.objectContaining({ id: 's-exited-a', name: 'exited-a', alive: false }),
  ]);
});
