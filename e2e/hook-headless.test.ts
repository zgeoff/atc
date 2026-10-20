import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { GrokAdapter } from '@atc/harness-grok';
import { DaemonError } from '@atc/protocol/wire';
import {
  buildMockAgentAdapter,
  buildStubHeadlessRunner,
  buildStubTimeoutScheduler,
  createGitFixture,
  getAgentEntry,
  getRecord,
  setupTempDir,
  updateEnv,
  waitFor,
} from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({ headlessRunner: headless.runner }),

      // A workspace clone reads a local upstream.
      gitTransports: ['https', 'ssh', 'http', 'file'],
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  return { daemon, runs: headless.runs, waitForRun: headless.waitForRun, scheduler };
}

test('it answers the eject of a terminal session with an empty reply', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const ejected = await ctx.daemon.client.sendRequest('session.eject', {
    session: getRecord(spawned, 'session')['id'],
    prompt: 'keep going',
  });

  expect(ejected).toStrictEqual({});
});

test('it ejects a terminal session into a headless run with its agent id', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs.map((run) => run.request)).toStrictEqual([
      {
        cwd: ctx.daemon.directory,
        prompt: 'keep going',
        resume: toAgentSessionID('sess-123'),
        sessionID,
        recordPath: join(ctx.daemon.directory, 'records', `${sessionID}.json`),
        reporterSocket: join(ctx.daemon.directory, 'reporter.sock'),
      },
    ]);
  });
});

test("it ejects a session into a headless run with the spawn's plugin folders, ~ expanded", async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  const home = setupTempDir('atc-headless-home-');

  mkdirSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'sh',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            pluginDirs: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
      homeDir: home.path,
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    resume: 'sess-123',
    pluginDirs: ['~/plugins/band'],
    cols: 80,
    rows: 24,
  });

  await daemon.client.sendRequest('session.eject', {
    session: getRecord(spawned, 'session')['id'],
    prompt: 'keep going',
  });

  scheduler.runTimer(4000);

  const run = await headless.waitForRun(0);

  expect(run.request.pluginDirs).toStrictEqual([join(home.path, 'plugins', 'band')]);
});

test('it lists an ejected session as a running headless session', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  await ctx.daemon.client.sendRequest('session.eject', {
    session: getRecord(spawned, 'session')['id'],
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs).toHaveLength(1);
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ kind: 'headless', alive: true, state: 'running' }]);
});

test('it starts the headless run of an ejected workspace session without its workspace credential', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-headless-workspace-' });

  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.daemon.directory, 'ws'),
    resume: 'sess-ws',
    workspace: {
      kind: 'git',
      url: git.upstream,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_CRED' },
    },
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs.map((run) => run.request)).toStrictEqual([
      {
        cwd: join(ctx.daemon.directory, 'ws'),
        prompt: 'keep going',
        resume: toAgentSessionID('sess-ws'),
        sessionID,
        withheldEnv: ['ATC_TEST_WORKSPACE_CRED', 'GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'],
        recordPath: join(ctx.daemon.directory, 'records', `${sessionID}.json`),
        reporterSocket: join(ctx.daemon.directory, 'reporter.sock'),
      },
    ]);
  });
});

test('it reports a finished headless turn as done', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onDone('wrapped up cleanly');

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({
      id: sessionID,
      state: 'done',
      lastMsg: 'wrapped up cleanly',
    });
  });
});

test('it reports a stuck headless turn as needs_you', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onNeedsYou('stuck on a decision');

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({
      id: sessionID,
      state: 'needs_you',
      lastMsg: 'stuck on a decision',
    });
  });
});

test("it keeps a finished headless turn's whole final message as the latest result", async () => {
  const ctx = await setupTest();

  const result = `Fixed the auth bug.\n\n${'The token refresh now retries once. '.repeat(10)}`;

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onDone(result);

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({ id: sessionID, state: 'done' });
  });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: sessionID });

  expect(record['result']).toBe(result);
});

test("it shows a finished headless turn's result as the session's latest detail", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onDone('all green after the retry fix');

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({
      id: sessionID,
      state: 'done',
      lastDetail: 'all green after the retry fix',
    });
  });
});

test("it records a headless turn's prompt in the event trail", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  const empty = await ctx.daemon.client.sendRequest('events.read', {});

  await ctx.daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  const started = await ctx.daemon.client.sendRequest('events.read', {
    cursor: empty['cursor'],
    waitMs: 5000,
  });

  expect(started['events']).toStrictEqual([
    expect.objectContaining({ session: sessionID, kind: 'prompt-submitted', detail: 'keep going' }),
  ]);
});

test("it records a headless turn's finish in the event trail", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  const empty = await ctx.daemon.client.sendRequest('events.read', {});

  await ctx.daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  const started = await ctx.daemon.client.sendRequest('events.read', {
    cursor: empty['cursor'],
    waitMs: 5000,
  });

  const run = await ctx.waitForRun(0);

  run.events.onDone('all green');

  const finished = await ctx.daemon.client.sendRequest('events.read', {
    cursor: started['cursor'],
    waitMs: 5000,
  });

  expect(finished['events']).toStrictEqual([
    expect.objectContaining({ session: sessionID, kind: 'turn-done', detail: 'all green' }),
  ]);
});

test('it records a stuck headless turn as needs-input in the event trail', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  const empty = await ctx.daemon.client.sendRequest('events.read', {});

  await ctx.daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  ctx.scheduler.runTimer(4000);

  const started = await ctx.daemon.client.sendRequest('events.read', {
    cursor: empty['cursor'],
    waitMs: 5000,
  });

  const run = await ctx.waitForRun(0);

  run.events.onNeedsYou('stuck on a decision');

  const stuck = await ctx.daemon.client.sendRequest('events.read', {
    cursor: started['cursor'],
    waitMs: 5000,
  });

  expect(stuck['events']).toStrictEqual([
    expect.objectContaining({
      session: sessionID,
      kind: 'needs-input',
      detail: 'stuck on a decision',
    }),
  ]);
});

test('it starts the next headless turn from session input once idle', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onDone('wrapped up cleanly');

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({ id: sessionID, state: 'done' });
  });

  const answered = await ctx.daemon.client.sendRequest('session.input', {
    session: sessionID,
    d: 'next task\n',
  });

  expect(answered).toStrictEqual({});

  expect(ctx.runs.map((started) => started.request)).toStrictEqual([
    {
      cwd: ctx.daemon.directory,
      prompt:
        'Continue the task autonomously. Verify your work as you go and stop when it is complete.',
      resume: toAgentSessionID('sess-123'),
      sessionID,
      recordPath: join(ctx.daemon.directory, 'records', `${sessionID}.json`),
      reporterSocket: join(ctx.daemon.directory, 'reporter.sock'),
    },
    {
      cwd: ctx.daemon.directory,
      prompt: 'next task',
      resume: toAgentSessionID('sess-123'),
      sessionID,
      recordPath: join(ctx.daemon.directory, 'records', `${sessionID}.json`),
      reporterSocket: join(ctx.daemon.directory, 'reporter.sock'),
    },
  ]);
});

test('it refuses input to a headless session mid-run', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs).toHaveLength(1);
  });

  expect(
    ctx.daemon.client.sendRequest('session.input', { session: sessionID, d: 'hasty\n' }),
  ).rejects.toMatchObject({ code: 'too_slow' });
});

test('it adopts a headless session back into a terminal', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  const run = await ctx.waitForRun(0);

  run.events.onDone('wrapped up cleanly');

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionState')
        .map((event) => event.session),
    ).toPartiallyContain({ id: sessionID, state: 'done' });
  });

  const adopted = await ctx.daemon.client.sendRequest('session.adopt', {
    session: sessionID,
    cols: 90,
    rows: 28,
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(adopted).toStrictEqual({});

  expect(listed).toMatchObject({
    sessions: [{ id: sessionID, kind: 'pty', alive: true, state: 'running' }],
  });
});

test('it stops the headless run of a session whose adopt is refused while its terminal is set up', async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  let refuseSpawn = false;

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        planSpawn: () => {
          if (refuseSpawn) {
            throw new DaemonError('unsupported_operation', 'the agent refuses this start');
          }

          return { bin: 'sleep', args: ['30'] };
        },
      }),
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.eject', { session: sessionID, prompt: 'keep going' });

  scheduler.runTimer(4000);

  await headless.waitForRun(0);

  refuseSpawn = true;

  const adopted = daemon.client.sendRequest('session.adopt', {
    session: sessionID,
    cols: 80,
    rows: 24,
  });

  await adopted.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(adopted).rejects.toMatchObject({ code: 'unsupported_operation' });
  expect(headless.runs.map((run) => run.stopped)).toStrictEqual([true]);
  expect(listed['sessions']).toMatchObject([{ id: sessionID, kind: 'headless' }]);
});

test('it keeps the headless run of a session whose adopt is refused for a plugin folder that is gone', async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  const home = setupTempDir('atc-headless-home-');

  mkdirSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'sh',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            pluginDirs: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
      homeDir: home.path,
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    resume: 'sess-123',
    pluginDirs: ['~/plugins/band'],
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.eject', { session: sessionID, prompt: 'keep going' });

  scheduler.runTimer(4000);

  await headless.waitForRun(0);

  rmSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const adopted = daemon.client.sendRequest('session.adopt', {
    session: sessionID,
    cols: 80,
    rows: 24,
  });

  await adopted.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(adopted).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(home.path, 'plugins', 'band')}' does not exist`,
  });

  expect(headless.runs.map((run) => run.stopped)).toStrictEqual([false]);

  expect(listed['sessions']).toMatchObject([
    { id: sessionID, kind: 'headless', alive: true, state: 'running' },
  ]);
});

test("it keeps the headless run of a session whose adopt is refused for a plugin folder the agent's config sets that is gone", async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  const home = setupTempDir('atc-headless-home-');

  mkdirSync(join(home.path, 'plugins', 'shared'), { recursive: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'sh',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            pluginDirs: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
          pluginDirs: [join(home.path, 'plugins', 'shared')],
        },
      }),
      homeDir: home.path,
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.eject', { session: sessionID, prompt: 'keep going' });

  scheduler.runTimer(4000);

  await headless.waitForRun(0);

  rmSync(join(home.path, 'plugins', 'shared'), { recursive: true });

  const adopted = daemon.client.sendRequest('session.adopt', {
    session: sessionID,
    cols: 80,
    rows: 24,
  });

  await adopted.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(adopted).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(home.path, 'plugins', 'shared')}' does not exist`,
  });

  expect(headless.runs.map((run) => run.stopped)).toStrictEqual([false]);

  expect(listed['sessions']).toMatchObject([
    { id: sessionID, kind: 'headless', alive: true, state: 'running' },
  ]);
});

test('it keeps the terminal of a session whose eject is refused for a plugin folder that is gone', async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  const home = setupTempDir('atc-headless-home-');

  mkdirSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'sh',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            pluginDirs: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
      homeDir: home.path,
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    resume: 'sess-123',
    pluginDirs: ['~/plugins/band'],
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  rmSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const ejected = daemon.client.sendRequest('session.eject', {
    session: sessionID,
    prompt: 'keep going',
  });

  await ejected.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(ejected).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(home.path, 'plugins', 'band')}' does not exist`,
  });

  expect(listed['sessions']).toMatchObject([{ id: sessionID, kind: 'pty', alive: true }]);
});

test('it refuses the next headless turn from session input once its plugin folder is gone', async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();
  const home = setupTempDir('atc-headless-home-');

  mkdirSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        headlessRunner: headless.runner,
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'sh',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            pluginDirs: {
              supported: true,
              values: null,
              examples: [],
              default: null,
              backendEffect: 'applied',
              note: null,
            },
          },
        },
      }),
      homeDir: home.path,
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    resume: 'sess-123',
    pluginDirs: ['~/plugins/band'],
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.eject', { session: sessionID, prompt: 'keep going' });

  scheduler.runTimer(4000);

  const run = await headless.waitForRun(0);

  run.events.onDone('wrapped up cleanly');

  rmSync(join(home.path, 'plugins', 'band'), { recursive: true });

  const input = daemon.client.sendRequest('session.input', {
    session: sessionID,
    d: 'next task\n',
  });

  await input.catch(() => null);

  expect(input).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(home.path, 'plugins', 'band')}' does not exist`,
  });

  expect(headless.runs).toHaveLength(1);
});

test('it refuses to eject a session that never reported an agent session id', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'no-id',
    cols: 80,
    rows: 24,
  });

  expect(
    ctx.daemon.client.sendRequest('session.eject', {
      session: getRecord(spawned, 'session')['id'],
    }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it reports eject as unsupported without a headless runner', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  expect(
    daemon.client.sendRequest('session.eject', { session: getRecord(spawned, 'session')['id'] }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it refuses to eject a grok session', async () => {
  const headless = buildStubHeadlessRunner();

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ headlessRunner: headless.runner }),
      adapters: [
        new GrokAdapter(
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'grok-handoff',
    agent: 'grok',
    resume: 'grok-sess-1',
    cols: 80,
    rows: 24,
  });

  expect(
    daemon.client.sendRequest('session.eject', { session: getRecord(spawned, 'session')['id'] }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message: "this session's agent has no headless handoff",
  });
});

// Every accepted eject schedules its handoff's settle, so the one settle
// scheduled after a refused eject and a later accepted one shows the
// refused eject scheduled no handoff.
test('it starts no headless run for a refused grok eject', async () => {
  const headless = buildStubHeadlessRunner();
  const scheduler = buildStubTimeoutScheduler();

  const daemon = await startTestDaemon({
    prefix: 'atc-headless-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ headlessRunner: headless.runner }),
      adapters: [
        new GrokAdapter(
          getAgentEntry(
            parseConfig(SHIPPED_HARNESS_PLUGINS, {
              agents: { grok: { bin: 'bash', args: ['-c', 'sleep 30'] } },
            }),
            'grok',
          ),
          join(paths.directory, 'grok-home'),
        ),
      ],
      scheduleEjectSettle: scheduler.schedule,
    }),
  });

  const grok = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'grok-handoff',
    agent: 'grok',
    resume: 'grok-sess-1',
    cols: 80,
    rows: 24,
  });

  const claude = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const claudeID = toSessionID(String(getRecord(claude, 'session')['id']));

  await Promise.allSettled([
    daemon.client.sendRequest('session.eject', { session: getRecord(grok, 'session')['id'] }),
  ]);

  await daemon.client.sendRequest('session.eject', { session: claudeID });

  const delays = scheduler.collectDelays();

  scheduler.runTimer(4000);

  await waitFor(() => {
    expect(headless.runs).toHaveLength(1);
  });

  expect(delays).toStrictEqual([4000]);
  expect(headless.runs.map((run) => run.request.sessionID)).toStrictEqual([claudeID]);
});

test("it stops a killed session's headless run", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs).toHaveLength(1);
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: sessionID });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(ctx.runs.map((run) => run.stopped)).toStrictEqual([true]);
  expect(listed['sessions']).toStrictEqual([]);
});

test('it refuses input for a killed headless session', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const sessionID = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.daemon.client.sendRequest('session.eject', { session: sessionID });

  ctx.scheduler.runTimer(4000);

  await waitFor(() => {
    expect(ctx.runs).toHaveLength(1);
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: sessionID });

  expect(
    ctx.daemon.client.sendRequest('session.input', { session: sessionID, d: 'anything\n' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});
