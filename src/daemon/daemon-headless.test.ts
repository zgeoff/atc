import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { updateEnv } from '../../test/update-env';
import type { AgentAdapter, HeadlessRunner } from '../agents/agent-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { startDaemon } from './daemon';

const sleepAdapter: AgentAdapter = {
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

interface FakeRun {
  readonly opts: Readonly<Record<string, unknown>>;
  readonly finish: (how: 'done' | 'stuck', result?: string) => void;
  readonly stopped: boolean;
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
      stopped: false,
      finish(how: 'done' | 'stuck', result = 'wrapped up cleanly') {
        if (how === 'done') {
          hooks.onDone(result);
        } else {
          hooks.onNeedsYou('stuck on a decision');
        }
      },
    };

    runs.push(entry);
    hooks.onOutput('HEADLESS LINE\r\n');

    return {
      stop() {
        entry.stopped = true;
      },
    };
  };

  const daemon = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: withRunner ? { ...sleepAdapter, headlessRunner: startFakeRun } : sleepAdapter,
    gitTransports: ['https', 'ssh', 'http', 'file'],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ejectSettleMs: 30,
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
    sessionID: id,
  });

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions[0]).toMatchObject({ kind: 'headless', alive: true, state: 'running' });
});

test('it starts the headless run of an ejected workspace session without its workspace credential', async () => {
  const ctx = await setupHeadlessDaemon();

  const dir = mkdtempSync(join(tmpdir(), 'atc-headless-workspace-'));

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  await $`git init --quiet --bare --initial-branch=main ${join(dir, 'up.git')}`.env(env).quiet();
  await $`git clone --quiet ${join(dir, 'up.git')} ${join(dir, 'work')}`.env(env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com commit --quiet --allow-empty -m one`
    .env(env)
    .cwd(join(dir, 'work'))
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(join(dir, 'work')).quiet();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: join(dir, 'ws'),
    resume: 'sess-ws',
    workspace: {
      kind: 'git',
      url: join(dir, 'up.git'),
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_CRED' },
    },
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.eject', { session: id, prompt: 'keep going' });

  await waitForRun(ctx.runs, 1);

  expect(ctx.runs[0]?.opts).toMatchObject({
    withheldEnv: ['ATC_TEST_WORKSPACE_CRED', 'GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'],
  });
});

test('it reports a finished headless turn as done', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done');

  const done = await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['id'] === id &&
      e['session']['state'] === 'done',
  );

  const doneSession = getRecord(done, 'session');

  expect(doneSession['lastMsg']).toBe('wrapped up cleanly');
});

test('it reports a stuck headless turn as needs_you', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('stuck');

  const needy = await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['id'] === id &&
      e['session']['state'] === 'needs_you',
  );

  const needySession = getRecord(needy, 'session');

  expect(needySession['lastMsg']).toBe('stuck on a decision');
});

test("it keeps a finished headless turn's whole final message as the latest result", async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  const result = `Fixed the auth bug.\n\n${'The token refresh now retries once. '.repeat(10)}`;

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done', result);

  await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['id'] === id &&
      e['session']['state'] === 'done',
  );

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(record['result']).toBe(result);
});

test("it shows a finished headless turn's result as the session's latest detail", async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done', 'all green after the retry fix');

  const done = await waitForEvent(
    ctx.events,
    (e) =>
      e.ev === 'SessionState' &&
      isRecord(e['session']) &&
      e['session']['id'] === id &&
      e['session']['state'] === 'done',
  );

  expect(getRecord(done, 'session')['lastDetail']).toBe('all green after the retry fix');
});

test("it records a headless turn's prompt and finish in the event trail", async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));
  const empty = await ctx.client.sendRequest('events.read', {});

  await ctx.client.sendRequest('session.eject', { session: id, prompt: 'keep going' });

  await waitForRun(ctx.runs, 1);

  const started = await ctx.client.sendRequest('events.read', {
    cursor: empty['cursor'],
    waitMs: 5000,
  });

  ctx.runs[0]?.finish('done', 'all green');

  const finished = await ctx.client.sendRequest('events.read', {
    cursor: started['cursor'],
    waitMs: 5000,
  });

  expect(started['events']).toStrictEqual([
    expect.objectContaining({ session: id, kind: 'prompt-submitted', detail: 'keep going' }),
  ]);

  expect(finished['events']).toStrictEqual([
    expect.objectContaining({ session: id, kind: 'turn-done', detail: 'all green' }),
  ]);
});

test('it records a stuck headless turn as needs-input in the event trail', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));
  const empty = await ctx.client.sendRequest('events.read', {});

  await ctx.client.sendRequest('session.eject', { session: id, prompt: 'keep going' });

  await waitForRun(ctx.runs, 1);

  const started = await ctx.client.sendRequest('events.read', {
    cursor: empty['cursor'],
    waitMs: 5000,
  });

  ctx.runs[0]?.finish('stuck');

  const stuck = await ctx.client.sendRequest('events.read', {
    cursor: started['cursor'],
    waitMs: 5000,
  });

  expect(stuck['events']).toStrictEqual([
    expect.objectContaining({ session: id, kind: 'needs-input', detail: 'stuck on a decision' }),
  ]);
});

test('it starts the next headless turn from session input once idle', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  ctx.runs[0]?.finish('done');

  await waitForEvent(
    ctx.events,
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

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

  await waitForEvent(
    ctx.events,
    (e) => e.ev === 'SessionState' && isRecord(e['session']) && e['session']['state'] === 'done',
  );

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
  const runs: HeadlessContext['runs'] = [];

  updateEnv('GROK_HOME', join(dir, 'grok-home'));

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    claudeAuth: null,
    claudeAuthErrors: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    gateways: [],
    gatewayErrors: [],
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
    resumeInterruptedTurns: false,
  });

  const startFakeRun: HeadlessRunner = (opts, hooks) => {
    runs.push({
      opts: { ...opts },
      stopped: false,
      finish() {},
    });

    hooks.onOutput('HEADLESS LINE\r\n');

    return { stop() {} };
  };

  const daemon = await startDaemon({
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

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

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

test("it stops a killed session's headless run and refuses further input for it", async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  await waitForRun(ctx.runs, 1);

  await ctx.client.sendRequest('session.kill', { session: id });

  expect(ctx.runs[0]?.stopped).toBe(true);

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions).toHaveLength(0);

  expect(
    ctx.client.sendRequest('session.input', { session: id, d: 'anything\n' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});
