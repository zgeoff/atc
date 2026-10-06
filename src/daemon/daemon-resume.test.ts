import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';

interface BootOptions {
  readonly resumeInterruptedTurns: boolean;
  readonly takesMessages: boolean;
}

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-daemon-resume-'));

  const dbPath = join(dir, 'state.db');
  const sockPath = join(dir, 'daemon.sock');
  const stops: (() => Promise<void>)[] = [];

  return {
    dbPath,
    async boot(options: BootOptions) {
      const adapter: AgentAdapter = {
        id: 'claude',
        headlessRunner: null,
        screenDetector: null,
        takesMessages: options.takesMessages,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'heartbeat' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => null,
      };

      const daemon = await startDaemon({
        socketPath: sockPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
        restoreBootTimeoutMs: 10,
        resumeInterruptedTurns: options.resumeInterruptedTurns,
      });

      const client = await DaemonClient.open(sockPath);

      let stopped = false;

      const stop = async () => {
        if (stopped) {
          return;
        }

        stopped = true;

        client.stop();

        await daemon.stop();
      };

      stops.push(stop);

      await client.sendHello('atc/test-build');

      return { client, stop };
    },
    async [Symbol.asyncDispose]() {
      for (const stop of stops.toReversed()) {
        await stop();
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it sends one resume message to a session whose turn the previous daemon stop cut off', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const booted = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: true });

  await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect(pending).toStrictEqual([
    {
      id: expect.toBeString(),
      atcID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      from: 'atc',
      text: expect.toSatisfy((text: string) =>
        /^atc restarted the daemon at \S+; your last turn was interrupted\. Check the state of anything you had in flight, then continue\.$/.test(
          text,
        ),
      ),
      status: 'accepted',
      sentAt: expect.toBeNumber(),
    },
  ]);
});

test.each([['turn-done'], ['needs-input']] as const)(
  'it sends no resume message to a session whose last turn event was %p',
  async (kind) => {
    await using daemon = await setupTest();

    const seed = await StateStore.open(daemon.dbPath);

    await seed.writeFleet([
      {
        sessionID: toSessionID('s-quiet'),
        agentSessionID: toAgentSessionID('a-quiet'),
        name: 'quiet',
        cwd: '/tmp',
        agent: 'claude',
      },
    ]);

    await seed.recordEvent(
      {
        atcId: toSessionID('s-quiet'),
        event: 'UserPromptSubmit',
        payload: { session_id: 'a-quiet' },
      },
      { kind: 'prompt-submitted' },
    );

    await seed.recordEvent(
      { atcId: toSessionID('s-quiet'), event: 'Stop', payload: { session_id: 'a-quiet' } },
      { kind },
    );

    await seed.stop();

    const booted = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: true });
    const restored = await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
    const listed = await booted.client.sendRequest('session.list');

    await booted.stop();

    const store = await StateStore.open(daemon.dbPath);
    const pending = await store.collectPendingMessages({ atcID: toSessionID('s-quiet') });

    await store.stop();

    expect({ restored, sessions: listed['sessions'], pending }).toMatchObject({
      restored: { restored: 1 },
      sessions: [{ id: 's-quiet', alive: true }],
      pending: [],
    });
  },
);

test('it sends no resume message when the config leaves resuming off and the spawn made no choice', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const booted = await daemon.boot({ resumeInterruptedTurns: false, takesMessages: true });
  const restored = await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await booted.client.sendRequest('session.list');

  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect({ restored, sessions: listed['sessions'], pending }).toMatchObject({
    restored: { restored: 1 },
    sessions: [{ id: 's-busy', alive: true, lastMsg: 'revived' }],
    pending: [],
  });
});

test("it sends a resume message when the spawn chose resuming over the config's off", async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
      resumeInterruptedTurns: true,
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const booted = await daemon.boot({ resumeInterruptedTurns: false, takesMessages: true });

  await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect(pending).toMatchObject([{ from: 'atc', status: 'accepted' }]);
});

test("it sends no resume message when the spawn declined resuming over the config's on", async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
      resumeInterruptedTurns: false,
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const booted = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: true });
  const restored = await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect({ restored, pending }).toStrictEqual({ restored: { restored: 1 }, pending: [] });
});

test('it sends no resume message to a session whose agent takes no atc messages', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const booted = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: false });
  const restored = await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect({ restored, pending }).toStrictEqual({ restored: { restored: 1 }, pending: [] });
});

test('it holds one resume message for a session across repeated restores and a second restart', async () => {
  await using daemon = await setupTest();

  const seed = await StateStore.open(daemon.dbPath);

  await seed.writeFleet([
    {
      sessionID: toSessionID('s-busy'),
      agentSessionID: toAgentSessionID('a-busy'),
      name: 'busy',
      cwd: '/tmp',
      agent: 'claude',
    },
  ]);

  await seed.recordEvent(
    { atcId: toSessionID('s-busy'), event: 'UserPromptSubmit', payload: { session_id: 'a-busy' } },
    { kind: 'prompt-submitted' },
  );

  await seed.stop();

  const first = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: true });

  await first.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await first.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await first.stop();

  const second = await daemon.boot({ resumeInterruptedTurns: true, takesMessages: true });

  await second.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await second.stop();

  const store = await StateStore.open(daemon.dbPath);
  const pending = await store.collectPendingMessages({ atcID: toSessionID('s-busy') });

  await store.stop();

  expect(pending).toMatchObject([{ from: 'atc', status: 'accepted' }]);
});

test('it keeps the choice a spawn made for resuming interrupted turns in the fleet row', async () => {
  await using daemon = await setupTest();

  const booted = await daemon.boot({ resumeInterruptedTurns: false, takesMessages: true });

  await booted.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    name: 'chosen',
    cols: 80,
    rows: 24,
    resumeInterruptedTurns: true,
  });

  await booted.stop();

  const store = await StateStore.open(daemon.dbPath);
  const fleet = await store.loadFleet();

  await store.stop();

  expect(fleet).toMatchObject([{ name: 'chosen', resumeInterruptedTurns: true }]);
});

test('it refuses a spawn whose choice for resuming interrupted turns is not a boolean', async () => {
  await using daemon = await setupTest();

  const booted = await daemon.boot({ resumeInterruptedTurns: false, takesMessages: true });

  const spawned = booted.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    cols: 80,
    rows: 24,
    resumeInterruptedTurns: 'yes',
  });

  expect(spawned).rejects.toMatchObject({ code: 'bad_args' });
});
