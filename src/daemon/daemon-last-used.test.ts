import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { DaemonClient } from '../client/daemon-client';
import { isRecord } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';

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

test('it does not write last-used when a restored session reports SessionStart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const prevHome = process.env['GROK_HOME'];
  const dbPath = join(dir, 'state.db');
  const sockPath = join(dir, 'daemon.sock');
  const reporterPath = join(dir, 'reporter.sock');

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const store = await StateStore.open(dbPath);

  await store.writeFleet([
    { name: 'old-grok', cwd: '/tmp', agentSessionID: toAgentSessionID('g-restore'), agent: 'grok' },
  ]);

  await store.writeLastUsedAgent('claude');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: reporterPath,
    build: 'atc/test-build',
    adapter: idleAdapter,
    adapters: [grok],
    dbPath,
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test-build');

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toMatchObject({ restored: 1 });

  const listed = await client.sendRequest('session.list');

  const sessions = listed['sessions'];

  if (!Array.isArray(sessions) || !isRecord(sessions[0]) || typeof sessions[0]['id'] !== 'string') {
    throw new Error('no restored session');
  }

  await sendHookEvent(reporterPath, {
    atcId: sessions[0]['id'],
    event: 'SessionStart',
    payload: { sessionId: 'g-restore' },
  });

  const deadline = Date.now() + 200;

  while (Date.now() < deadline) {
    const probe = await DaemonClient.open(sockPath);
    const hello = await probe.sendHello('atc/test-build');

    probe.stop();

    expect(hello).toMatchObject({ lastUsedAgent: 'claude' });

    await Bun.sleep(20);
  }

  const spawned = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const session = spawned['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  await sendHookEvent(reporterPath, {
    atcId: session['id'],
    event: 'SessionStart',
    payload: { sessionId: 'g-deliberate' },
  });

  const lastUsed = await waitForLastUsedAgent(sockPath, 'grok');

  expect(lastUsed).toBe('grok');
});

interface HookEventLine {
  readonly atcId: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function sendHookEvent(reporterPath: string, event: HookEventLine) {
  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    unix: reporterPath,
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify(event)}\n`);
        socket.end();
      },
      close() {
        closed.resolve();
      },
      data() {},
      error() {},
    },
  });

  await closed.promise;
}

async function waitForLastUsedAgent(sockPath: string, agent: 'claude' | 'grok'): Promise<string> {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const probe = await DaemonClient.open(sockPath);
    const hello = await probe.sendHello('atc/test-build');

    probe.stop();

    if (hello['lastUsedAgent'] === agent) {
      return agent;
    }

    await Bun.sleep(20);
  }

  throw new Error(`lastUsedAgent never became ${agent}`);
}
