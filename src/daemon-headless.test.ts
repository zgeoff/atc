import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, HeadlessRunner } from './agent-adapter';
import { startDaemon } from './daemon';
import { DaemonClient } from './daemon-client';
import { GrokAdapter } from './grok-adapter';
import type { EventMsg } from './protocol';
import { isRecord } from './report';

const sleepAdapter: AgentAdapter = {
  id: 'claude',
  kind: 'claude',
  headlessRunner: null,
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

interface FakeRun {
  readonly opts: Readonly<Record<string, unknown>>;
  readonly finish: (how: 'done' | 'stuck') => void;
}

interface HeadlessContext {
  readonly client: DaemonClient;
  readonly events: EventMsg[];
  readonly runs: FakeRun[];
}

async function waitForRun(runs: readonly FakeRun[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;

  while (runs.length < count && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  if (runs.length < count) {
    throw new Error(`headless run ${count} never started`);
  }
}

async function setupHeadlessDaemon(withRunner = true): Promise<HeadlessContext> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-headless-'));
  const runs: HeadlessContext['runs'] = [];

  const startFakeRun: HeadlessRunner = (opts, hooks) => {
    const entry = {
      opts: { ...opts },
      finish(how: 'done' | 'stuck') {
        if (how === 'done') {
          hooks.onDone('wrapped up cleanly');
        } else {
          hooks.onNeedsYou('stuck on a decision');
        }
      },
    };

    runs.push(entry);
    hooks.onOutput('HEADLESS LINE\r\n');

    return { stop() {} };
  };

  const daemon = startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: withRunner ? { ...sleepAdapter, headlessRunner: startFakeRun } : sleepAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ejectSettleMs: 30,
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

  return { client, events, runs };
}

type SendRequest = DaemonClient['sendRequest'];

async function spawnResumable(send: SendRequest): Promise<string> {
  const ok = await send('session.spawn', {
    cwd: '/tmp',
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  return spawned['id'];
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

test('it ejects a terminal session into a headless run with its agent id', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));
  const ok = await ctx.client.sendRequest('session.eject', { session: id, prompt: 'keep going' });

  expect(ok).toStrictEqual({});

  await waitForRun(ctx.runs, 1);

  expect(ctx.runs[0]?.opts).toStrictEqual({
    cwd: '/tmp',
    prompt: 'keep going',
    resume: 'sess-123',
    permissionMode: 'auto',
  });

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions[0]).toMatchObject({ kind: 'headless', alive: true, state: 'running' });
});

test('it reports a finished headless turn as done', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done');

  const done = await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.state' && e['s'] === id && e['state'] === 'done',
  );

  expect(done['lastMsg']).toBe('wrapped up cleanly');
});

test('it reports a stuck headless turn as needs_you', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('stuck');

  const needy = await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.state' && e['s'] === id && e['state'] === 'needs_you',
  );

  expect(needy['lastMsg']).toBe('stuck on a decision');
});

test('it starts the next headless turn from session input once idle', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done');

  await waitForEvent(ctx.events, (e) => e.ev === 'session.state' && e['state'] === 'done');

  const ok = await ctx.client.sendRequest('session.input', { session: id, d: 'next task\n' });

  expect(ok).toStrictEqual({});
  expect(ctx.runs).toHaveLength(2);
  expect(ctx.runs[1]?.opts).toMatchObject({ prompt: 'next task', resume: 'sess-123' });
});

test('it refuses input to a headless session mid-run', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  expect(
    ctx.client.sendRequest('session.input', { session: id, d: 'hasty\n' }),
  ).rejects.toMatchObject({ code: 'too_slow' });
});

test('it adopts a headless session back into a terminal', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done');

  await waitForEvent(ctx.events, (e) => e.ev === 'session.state' && e['state'] === 'done');

  const ok = await ctx.client.sendRequest('session.adopt', { session: id, cols: 90, rows: 28 });

  expect(ok).toStrictEqual({});

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions[0]).toMatchObject({ kind: 'pty', alive: true, state: 'running' });
});

test('it refuses to eject a session that never reported an agent session id', async () => {
  const ctx = await setupHeadlessDaemon();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    name: 'no-id',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  expect(ctx.client.sendRequest('session.eject', { session: spawned['id'] })).rejects.toMatchObject(
    { code: 'no_such_session' },
  );
});

test('it reports eject as unsupported without a headless runner', async () => {
  const ctx = await setupHeadlessDaemon(false);
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  expect(ctx.client.sendRequest('session.eject', { session: id })).rejects.toMatchObject({
    code: 'unsupported',
  });
});

test('it refuses to eject a grok session and does not start a headless runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-headless-'));
  const prevHome = process.env['GROK_HOME'];
  const runs: HeadlessContext['runs'] = [];

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    leader: { code: 0, label: '^Space' },
  });

  const startFakeRun: HeadlessRunner = (opts, hooks) => {
    runs.push({
      opts: { ...opts },
      finish() {},
    });

    hooks.onOutput('HEADLESS LINE\r\n');

    return { stop() {} };
  };

  const daemon = startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: { ...sleepAdapter, headlessRunner: startFakeRun },
    adapters: [grok],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ejectSettleMs: 30,
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
    daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    name: 'grok-handoff',
    agent: 'grok',
    resume: 'grok-sess-1',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  expect(client.sendRequest('session.eject', { session: spawned['id'] })).rejects.toMatchObject({
    code: 'unsupported',
    message: "this session's agent has no headless handoff",
  });

  // Eject settle is 30ms; wait it out so a mistaken runner start would have landed.
  await Bun.sleep(50);

  expect(runs).toHaveLength(0);
});
