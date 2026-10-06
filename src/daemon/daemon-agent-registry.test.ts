import { expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { isRecord } from '../shared/report';
import { startDaemon } from './daemon';

/**
 * A real daemon whose adapters come from an agents map, with a fake
 * Claude binary that records its argv under the temp tree and sleeps.
 */
async function setupTest(agents: (fakeClaude: string) => unknown) {
  const tmp = setupTempDir('atc-daemon-agent-registry-');
  const fakeClaude = join(tmp.dir, 'fake-claude');

  writeFileSync(fakeClaude, `#!/bin/bash\nprintf '%s\\n' "$@" > "${tmp.dir}/argv$1"\nsleep 30\n`);
  chmodSync(fakeClaude, 0o755);

  const config = parseConfig({ agents: agents(fakeClaude) });
  const sockPath = join(tmp.dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: buildAgentAdapters(config),
    defaultAgent: config.defaultAgent,
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    dir: tmp.dir,
    config,
    client,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it spawns two claude entries each with its own args and settings file', async () => {
  await using daemon = await setupTest((fakeClaude) => ({
    claude: { bin: fakeClaude, args: ['--a'] },
    'claude-b': {
      kind: 'claude',
      bin: fakeClaude,
      args: ['--b'],
      env: { FROM_ENTRY: '1' },
      settings: { outputStyle: 'registry-marker', env: { FROM_SETTINGS: '1' } },
    },
  }));

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'claude-b',
    cols: 80,
    rows: 24,
  });

  expect(first['session']).toMatchObject({ agent: 'claude' });
  expect(second['session']).toMatchObject({ agent: 'claude-b' });

  const firstArgv = await waitFor(() =>
    readFileSync(join(daemon.dir, 'argv--a'), 'utf8').split('\n'),
  );

  const secondArgv = await waitFor(() =>
    readFileSync(join(daemon.dir, 'argv--b'), 'utf8').split('\n'),
  );

  const firstFile = firstArgv[firstArgv.indexOf('--settings') + 1] ?? '';
  const secondFile = secondArgv[secondArgv.indexOf('--settings') + 1] ?? '';
  const firstSettings: unknown = JSON.parse(readFileSync(firstFile, 'utf8'));
  const secondSettings: unknown = JSON.parse(readFileSync(secondFile, 'utf8'));

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
    settingsDiffer: firstPlan.args.join(' ') !== secondPlan.args.join(' '),
  }).toStrictEqual({
    ids: ['claude', 'claude-b'],
    bins: ['one', 'two'],
    leading: ['--a', '--b'],
    settingsDiffer: true,
  });
});

test('it lists no agent, refuses a spawn, and still starts for an empty registry', async () => {
  await using daemon = await setupTest(() => ({}));

  const listed = await daemon.client.sendRequest('agents.list');

  expect({ agents: listed['agents'], defaults: listed['spawnDefaults'] }).toMatchObject({
    agents: [],
    defaults: { agent: 'claude' },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message: "no adapter for agent 'claude'",
  });
});

test('it spawns the first entry when the registry holds no claude and the spawn names none', async () => {
  await using daemon = await setupTest((fakeClaude) => ({
    'claude-b': { kind: 'claude', bin: fakeClaude, args: ['--b'] },
  }));

  const listed = await daemon.client.sendRequest('agents.list');

  const defaults = listed['spawnDefaults'];

  if (!isRecord(defaults)) {
    throw new Error('no spawn defaults');
  }

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
  });

  expect(defaults['agent']).toBe('claude-b');
  expect(spawned['session']).toMatchObject({ agent: 'claude-b' });
});
