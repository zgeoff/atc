import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { parseConfig } from '../shared/config';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

interface SetupConfig {
  // The raw `agents` map of a config.json, given the fake Claude's path.
  readonly agents: (fakeClaude: string) => unknown;
}

/**
 * A real daemon whose adapters come from a raw agents map through the real
 * config parse. The map's entries can run the fake Claude, a binary
 * under the temp tree that writes its argv, one argument per line,
 * to `argv<first argument>` beside it and sleeps.
 */
function setupTest(config: SetupConfig) {
  return startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: (paths) => {
      const fakeClaude = createStubBin(
        paths.dir,
        'fake-claude',
        `#!/bin/bash\nprintf '%s\\n' "$@" > "${paths.dir}/argv$1"\nsleep 30\n`,
      );

      const parsed = parseConfig({ agents: config.agents(fakeClaude) });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });
}

test('it spawns two claude entries each with its own args and settings file', async () => {
  await using ctx = await setupTest({
    agents: (fakeClaude) => ({
      claude: { bin: fakeClaude, args: ['--a'] },
      'claude-b': {
        kind: 'claude',
        bin: fakeClaude,
        args: ['--b'],
        env: { FROM_ENTRY: '1' },
        settings: { outputStyle: 'registry-marker', env: { FROM_SETTINGS: '1' } },
      },
    }),
  });

  const first = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const second = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'claude-b',
    cols: 80,
    rows: 24,
  });

  const firstArgv = await waitFor(() => readFileSync(join(ctx.dir, 'argv--a'), 'utf8').split('\n'));

  const secondArgv = await waitFor(() =>
    readFileSync(join(ctx.dir, 'argv--b'), 'utf8').split('\n'),
  );

  const firstFile = firstArgv[firstArgv.indexOf('--settings') + 1] ?? '';
  const secondFile = secondArgv[secondArgv.indexOf('--settings') + 1] ?? '';
  const firstSettings: unknown = JSON.parse(readFileSync(firstFile, 'utf8'));
  const secondSettings: unknown = JSON.parse(readFileSync(secondFile, 'utf8'));

  expect(first['session']).toMatchObject({ agent: 'claude' });
  expect(second['session']).toMatchObject({ agent: 'claude-b' });
  expect(firstArgv[0]).toBe('--a');
  expect(secondArgv[0]).toBe('--b');
  expect(firstFile).toEndWith('hook-settings-claude.json');
  expect(secondFile).toEndWith('hook-settings-claude-b.json');

  expect(secondSettings).toMatchObject({
    outputStyle: 'registry-marker',
    env: { FROM_ENTRY: '1', FROM_SETTINGS: '1' },
  });

  expect(firstSettings).not.toHaveProperty('outputStyle');
});

test('it builds two claude adapters with distinct ids and spawn plans from one registry', () => {
  const config = parseConfig({
    agents: {
      claude: { bin: 'one', args: ['--a'] },
      'claude-b': { kind: 'claude', bin: 'two', args: ['--b'] },
    },
  });

  const [first, second] = buildAgentAdapters(config);

  if (!(first instanceof ClaudeAdapter) || !(second instanceof ClaudeAdapter)) {
    throw new Error('expected two claude adapters');
  }

  const firstPlan = first.planSpawn({ prompt: '', resume: false });
  const secondPlan = second.planSpawn({ prompt: '', resume: false });

  expect({
    ids: [first.id, second.id],
    bins: [firstPlan.bin, secondPlan.bin],
    leading: [firstPlan.args[0], secondPlan.args[0]],
  }).toStrictEqual({
    ids: ['claude', 'claude-b'],
    bins: ['one', 'two'],
    leading: ['--a', '--b'],
  });

  expect(firstPlan.args).not.toStrictEqual(secondPlan.args);
});

test('it lists no agent and defaults spawns to claude for an empty registry', async () => {
  await using ctx = await setupTest({ agents: () => ({}) });

  const listed = await ctx.client.sendRequest('agents.list');

  expect({ agents: listed['agents'], defaults: listed['spawnDefaults'] }).toMatchObject({
    agents: [],
    defaults: { agent: 'claude' },
  });
});

test('it refuses a spawn for an empty registry', async () => {
  await using ctx = await setupTest({ agents: () => ({}) });

  expect(
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message: "no adapter for agent 'claude'",
  });
});

test('it defaults spawns to the first entry when the registry holds no claude', async () => {
  await using ctx = await setupTest({
    agents: (fakeClaude) => ({
      'claude-b': { kind: 'claude', bin: fakeClaude, args: ['--b'] },
    }),
  });

  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['spawnDefaults']).toMatchObject({ agent: 'claude-b' });
});

test('it spawns the first entry when the registry holds no claude and the spawn names none', async () => {
  await using ctx = await setupTest({
    agents: (fakeClaude) => ({
      'claude-b': { kind: 'claude', bin: fakeClaude, args: ['--b'] },
    }),
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'claude-b' });
});
