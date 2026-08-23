import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { startDaemon } from './daemon';

// A hook-less agent: a shell that paints a prompt, waits for input, works
// visibly, then prompts again. Attention comes only from the screen tier.
const promptAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: {
    detectAttention: (screen) => (screen.trimEnd().endsWith('READY>') ? 'needs-input' : 'working'),
  },
  planSpawn: () => ({
    bin: 'bash',
    args: [
      '-c',
      String.raw`printf "READY>"; read -r line; printf "crunching %s\n" "$line"; sleep 30`,
    ],
  }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

// Same visible prompt, but no screen tier — its output must never be judged.
const undetectedAdapter: AgentAdapter = { ...promptAdapter, screenDetector: null };

async function setupDetectorDaemon(adapter: AgentAdapter = promptAdapter): Promise<{
  readonly client: DaemonClient;
  readonly events: EventMsg[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-detector-'));

  const daemon = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test');

  return { client, events };
}

async function waitForEvent(
  events: readonly EventMsg[],
  matches: (e: EventMsg) => boolean,
): Promise<EventMsg> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const found = events.find((e) => matches(e));

    if (found !== undefined) {
      return found;
    }

    await Bun.sleep(20);
  }

  throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.ev))}`);
}

test('it flags a hook-less agent waiting at a prompt via the screen detector', async () => {
  const ctx = await setupDetectorDaemon();
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 60, rows: 12 });

  const spawned = ok['session'];

  if (typeof spawned !== 'object' || spawned === null) {
    throw new Error('no session in spawn answer');
  }

  const needy = await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  const needySession = getRecord(needy, 'session');

  expect(needySession['lastMsg']).toBe('waiting at a prompt');
});

test('it flips the session back to working once the prompt is answered', async () => {
  const ctx = await setupDetectorDaemon();
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 60, rows: 12 });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  const id = spawned['id'];

  await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  await ctx.client.sendRequest('session.input', { session: id, d: 'go\n' });

  const working = await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'session.state' &&
      isRecord(e['session']) &&
      e['session']['state'] === 'running' &&
      e['session']['lastMsg'] === 'working',
  );

  const workingSession = getRecord(working, 'session');

  expect(workingSession['id']).toBe(id);
});

test('it opens a permission request from a screen-detected prompt', async () => {
  const ctx = await setupDetectorDaemon();

  await ctx.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 60, rows: 12 });

  const requested = await waitForEvent(ctx.events, (e) => e.ev === 'permission.requested');

  expect(requested).toMatchObject({ message: 'waiting at a prompt', respondable: false });
});

test('it never flags a prompt as needing input when the adapter has no screen detector', async () => {
  const ctx = await setupDetectorDaemon(undetectedAdapter);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 60,
    rows: 12,
  });

  // Output only reaches an attached client, and the painted prompt is the one
  // observable signal that this session reached the state a detector would
  // judge. Attaching does not perturb detection: it runs off PTY output either
  // way, and the session is running rather than needing input at this point.
  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.attach', { session: id, cols: 60, rows: 12 });

  await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.output' && typeof e['d'] === 'string' && e['d'].includes('READY>'),
  );

  // Then out past the 300ms detect debounce a detector would have needed.
  await Bun.sleep(400);

  const needy = ctx.events.find(
    (e) =>
      e.ev === 'session.state' && isRecord(e['session']) && e['session']['state'] === 'needs_you',
  );

  expect(needy).toBeUndefined();
});
