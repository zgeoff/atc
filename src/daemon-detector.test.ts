import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { startDaemon } from './daemon';
import { DaemonClient } from './daemon-client';
import type { EventMsg } from './protocol';
import { isRecord } from './report';

// A hook-less agent: a shell that paints a prompt, waits for input, works
// visibly, then prompts again. Attention comes only from the screen tier.
const promptAdapter: AgentAdapter = {
  id: 'claude',
  kind: 'claude',
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

async function setupDetectorDaemon(): Promise<{
  readonly client: DaemonClient;
  readonly events: EventMsg[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-detector-'));

  const daemon = startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: promptAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  onTestFinished(() => {
    client.stop();
    daemon.stop();

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
    (e) => e.ev === 'session.state' && e['state'] === 'needs_you',
  );

  expect(needy['lastMsg']).toBe('waiting at a prompt');
});

test('it flips the session back to working once the prompt is answered', async () => {
  const ctx = await setupDetectorDaemon();
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 60, rows: 12 });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  const id = spawned['id'];

  await waitForEvent(ctx.events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  await ctx.client.sendRequest('session.input', { session: id, d: 'go\n' });

  const working = await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.state' && e['state'] === 'running' && e['lastMsg'] === 'working',
  );

  expect(working['s']).toBe(id);
});

test('it opens a permission request from a screen-detected prompt', async () => {
  const ctx = await setupDetectorDaemon();

  await ctx.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 60, rows: 12 });

  const requested = await waitForEvent(ctx.events, (e) => e.ev === 'permission.requested');

  expect(requested).toMatchObject({ message: 'waiting at a prompt', respondable: false });
});
