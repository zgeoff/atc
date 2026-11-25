import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startStubAgentDaemon } from '@atc/app/test-utils/start-stub-agent-daemon';
import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getRecords } from '@atc/core/test-utils/get-records';
import { getString } from '@atc/core/test-utils/get-string';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import { waitFor } from '@zgeoff/testing';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';

async function setupTest() {
  const stub = await startStubAgentDaemon({
    agents: (bins) => ({
      claude: { bin: bins.claude },
      main: { kind: 'claude', bin: bins.claude },
      plain: { kind: 'grok', bin: bins.grok },
    }),
    targets: [LOCAL_TARGET, { id: 'other', provider: 'local-pty', options: {} }],
  });

  return {
    ...stub,
    buildAdapters: (entries: object) =>
      buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: entries }),
        buildMockHostServices(),
      ),
  };
}

test('it spawns an agent that a reload adds, lists it, and changes the config revision', async () => {
  const ctx = await setupTest();
  const before = await ctx.daemon.client.sendRequest('agents.list');

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent: 'zai',
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({
      claude: { bin: ctx.agents.bins.claude },
      zai: { kind: 'claude', bin: ctx.agents.bins.claude },
    }),
    defaultAgent: 'claude',
    defaultTarget: 'local',
    hooks: {},
  });

  const after = await ctx.daemon.client.sendRequest('agents.list');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 80,
    rows: 24,
  });

  const listedIDs = getRecords(after, 'agents').map((agent) => agent['id']);

  expect(listedIDs).toStrictEqual(['claude', 'zai']);
  expect(after['configRevision']).not.toBe(before['configRevision']);
  expect(getRecord(spawned, 'session')['agent']).toBe('zai');
});

test('it keeps the adapter of a running session when a reload changes its entry', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const running = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'main',
    cols: 80,
    rows: 24,
  });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ main: { kind: 'grok', bin: ctx.agents.bins.grok } }),
    defaultAgent: 'main',
    defaultTarget: 'local',
    hooks: {},
  });

  ctx.agents.holdStart('grok');

  const fresh = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'main',
    cols: 80,
    rows: 24,
  });

  const kept = await ctx.daemon.client.sendRequest('session.message', {
    session: getString(getRecord(running, 'session'), 'id'),
    text: 'hello',
  });

  expect(kept).toStrictEqual({
    message: expect.stringMatching(/^m-[\da-f-]{36}$/u),
    status: 'queued',
  });

  const freshID = getString(getRecord(fresh, 'session'), 'id');

  const refused = ctx.daemon.client.sendRequest('session.message', {
    session: freshID,
    text: 'hello',
  });

  expect(refused).rejects.toMatchObject({ code: 'unsupported' });
});

test('it keeps a running session working after a reload removes its entry', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const running = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'main',
    cols: 80,
    rows: 24,
  });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ claude: { bin: ctx.agents.bins.claude } }),
    defaultAgent: 'claude',
    defaultTarget: 'local',
    hooks: {},
  });

  const kept = await ctx.daemon.client.sendRequest('session.message', {
    session: getString(getRecord(running, 'session'), 'id'),
    text: 'hello',
  });

  expect(kept).toStrictEqual({
    message: expect.stringMatching(/^m-[\da-f-]{36}$/u),
    status: 'queued',
  });

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent: 'main',
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it applies the hooks, default agent and default target a reload brings to the next spawn', async () => {
  const ctx = await setupTest();

  const marker = join(ctx.home, 'added.marker');

  const problems = ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({
      claude: { bin: ctx.agents.bins.claude },
      main: { kind: 'claude', bin: ctx.agents.bins.claude },
    }),
    defaultAgent: 'main',
    defaultTarget: 'other',
    hooks: { SessionAdded: [{ command: `touch '${marker}'` }] },
  });

  const listed = await ctx.daemon.client.sendRequest('agents.list');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(existsSync(marker)).toBeTrue();
  });

  expect(problems).toStrictEqual([]);
  expect(listed['spawnDefaults']).toStrictEqual({ agent: 'main', target: 'other' });
  expect(getRecord(spawned, 'session')['agent']).toBe('main');
  expect(getRecord(getRecord(spawned, 'session'), 'place')['label']).toBe('other');
});

test('it keeps the default target and reports a problem when a reload names an unbuilt target', async () => {
  const ctx = await setupTest();

  const problems = ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ claude: { bin: ctx.agents.bins.claude } }),
    defaultAgent: 'claude',
    defaultTarget: 'ghost',
    hooks: {},
  });

  const listed = await ctx.daemon.client.sendRequest('agents.list');

  expect(problems).toStrictEqual([
    "defaultTarget 'ghost' names no target this daemon built, so the default target stays 'local'; a restart applies target changes",
  ]);

  expect(listed['spawnDefaults']).toStrictEqual({ agent: 'claude', target: 'local' });
});

test('it pins the reloaded adapter when a stopped session is adopted after a reload', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'plain',
    resume: 'sess-1',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id, stopOnly: true });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ plain: { kind: 'claude', bin: ctx.agents.bins.claude } }),
    defaultAgent: 'plain',
    defaultTarget: 'local',
    hooks: {},
  });

  ctx.agents.holdStart('claude');

  await ctx.daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ claude: { bin: ctx.agents.bins.claude } }),
    defaultAgent: 'claude',
    defaultTarget: 'local',
    hooks: {},
  });

  const kept = await ctx.daemon.client.sendRequest('session.message', { session: id, text: 'hi' });

  expect(kept).toStrictEqual({
    message: expect.stringMatching(/^m-[\da-f-]{36}$/u),
    status: 'queued',
  });
});

test('it pins the reloaded adapter when a session is restored after a reload', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'plain',
    resume: 'sess-1',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id, stopOnly: true });
  await ctx.daemon.restart();

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ plain: { kind: 'claude', bin: ctx.agents.bins.claude } }),
    defaultAgent: 'plain',
    defaultTarget: 'local',
    hooks: {},
  });

  await ctx.daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ claude: { bin: ctx.agents.bins.claude } }),
    defaultAgent: 'claude',
    defaultTarget: 'local',
    hooks: {},
  });

  const answer = await ctx.daemon.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && ${ctx.agents.bins.claude} --resume sess-1`,
  });
});

test('it adopts a session whose old plugin folder a reload dropped from its entry', async () => {
  const ctx = await setupTest();

  const folder = join(ctx.home, 'plugins', 'old');

  mkdirSync(folder, { recursive: true });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({
      main: { kind: 'claude', bin: ctx.agents.bins.claude, pluginDirs: [folder] },
    }),
    defaultAgent: 'main',
    defaultTarget: 'local',
    hooks: {},
  });

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'main',
    resume: 'sess-1',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await ctx.daemon.client.sendRequest('session.kill', { session: id, stopOnly: true });

  rmSync(folder, { recursive: true });

  ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ main: { kind: 'grok', bin: ctx.agents.bins.grok } }),
    defaultAgent: 'main',
    defaultTarget: 'local',
    hooks: {},
  });

  const adopted = await ctx.daemon.client.sendRequest('session.adopt', {
    session: id,
    cols: 80,
    rows: 24,
  });

  expect(adopted).toStrictEqual({});
});
