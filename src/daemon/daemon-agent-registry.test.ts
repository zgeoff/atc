import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

test('it spawns two claude entries each with its own args and settings file', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: (paths) => {
      const parsed = parseConfig({
        agents: {
          claude: { bin: createStubRecordingClaude(join(paths.dir, 'a')), args: ['--a'] },
          'claude-b': {
            kind: 'claude',
            bin: createStubRecordingClaude(join(paths.dir, 'b')),
            args: ['--b'],
            env: { FROM_ENTRY: '1' },
            settings: { outputStyle: 'registry-marker', env: { FROM_SETTINGS: '1' } },
          },
        },
      });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });

  const first = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const second = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude-b',
    cols: 80,
    rows: 24,
  });

  const firstArgv = await waitFor(() => {
    const log = readFileSync(join(daemon.dir, 'a', 'claude-starts.log'), 'utf8');

    expect(log).toEndWith('\n\n');

    return log.split('\n');
  });

  const secondArgv = await waitFor(() => {
    const log = readFileSync(join(daemon.dir, 'b', 'claude-starts.log'), 'utf8');

    expect(log).toEndWith('\n\n');

    return log.split('\n');
  });

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

test('it lists no agent and defaults spawns to claude for an empty registry', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: () => {
      const parsed = parseConfig({ agents: {} });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect({ agents: listed['agents'], defaults: listed['spawnDefaults'] }).toMatchObject({
    agents: [],
    defaults: { agent: 'claude' },
  });
});

test('it refuses a spawn for an empty registry', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: () => {
      const parsed = parseConfig({ agents: {} });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message: "no adapter for agent 'claude'",
  });
});

test('it defaults spawns to the first entry when the registry holds no claude', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: (paths) => {
      const parsed = parseConfig({
        agents: {
          'claude-b': { kind: 'claude', bin: createStubRecordingClaude(paths.dir), args: ['--b'] },
        },
      });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['spawnDefaults']).toMatchObject({ agent: 'claude-b' });
});

test('it spawns the first entry when the registry holds no claude and the spawn names none', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-agent-registry-',
    options: (paths) => {
      const parsed = parseConfig({
        agents: {
          'claude-b': { kind: 'claude', bin: createStubRecordingClaude(paths.dir), args: ['--b'] },
        },
      });

      return { adapters: buildAgentAdapters(parsed), defaultAgent: parsed.defaultAgent };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  expect(spawned['session']).toMatchObject({ agent: 'claude-b' });
});
