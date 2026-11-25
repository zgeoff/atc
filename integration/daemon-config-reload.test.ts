import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startStubAgentDaemon } from '@atc/app/test-utils/start-stub-agent-daemon';
import { parseConfig } from '@atc/config';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import { waitFor } from '@zgeoff/testing';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';

type StubAgentEntries = NonNullable<
  NonNullable<Parameters<typeof startStubAgentDaemon>[0]>['agents']
>;

async function setupTest(agents: StubAgentEntries) {
  const stub = await startStubAgentDaemon({ agents });

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
  const ctx = await setupTest((bins) => ({ claude: { bin: bins.claude } }));
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

  expect(after['agents']).toSatisfyAny(
    (agent: Readonly<Record<string, unknown>>) => agent['id'] === 'zai',
  );

  expect(after['configRevision']).not.toBe(before['configRevision']);
  expect(spawned).toMatchObject({ session: { agent: 'zai', alive: true } });
});

test('it keeps the adapter of a running session when a reload changes its entry', async () => {
  const ctx = await setupTest((bins) => ({ main: { kind: 'claude', bin: bins.claude } }));

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

  expect(kept).toMatchObject({ status: 'queued' });

  const freshID = getString(getRecord(fresh, 'session'), 'id');

  expect(
    ctx.daemon.client.sendRequest('session.message', { session: freshID, text: 'hello' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it keeps a running session working after a reload removes its entry', async () => {
  const ctx = await setupTest((bins) => ({
    claude: { bin: bins.claude },
    zai: { kind: 'claude', bin: bins.claude },
  }));

  ctx.agents.holdStart('claude');

  const running = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
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

  expect(kept).toMatchObject({ status: 'queued' });

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent: 'zai',
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it applies the hooks and the default agent a reload brings to the next spawn', async () => {
  const ctx = await setupTest((bins) => ({
    claude: { bin: bins.claude },
    zai: { kind: 'claude', bin: bins.claude },
  }));

  const marker = join(ctx.home, 'added.marker');

  const problems = ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({
      claude: { bin: ctx.agents.bins.claude },
      zai: { kind: 'claude', bin: ctx.agents.bins.claude },
    }),
    defaultAgent: 'zai',
    defaultTarget: 'local',
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
  expect(listed['spawnDefaults']).toStrictEqual({ agent: 'zai', target: 'local' });
  expect(spawned).toMatchObject({ session: { agent: 'zai' } });
});

test('it keeps the default target and reports a problem when a reload names an unbuilt target', async () => {
  const ctx = await setupTest((bins) => ({ claude: { bin: bins.claude } }));

  const problems = ctx.daemon.daemon.reloadConfig({
    adapters: ctx.buildAdapters({ claude: { bin: ctx.agents.bins.claude } }),
    defaultAgent: 'claude',
    defaultTarget: 'ghost',
    hooks: {},
  });

  const listed = await ctx.daemon.client.sendRequest('agents.list');

  expect(problems).toStrictEqual([expect.stringContaining("defaultTarget 'ghost'")]);
  expect(listed['spawnDefaults']).toStrictEqual({ agent: 'claude', target: 'local' });
});
