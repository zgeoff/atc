import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { createImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';
import {
  buildMockHostServices,
  createStubRecordingClaude,
  getRecord,
  getRecords,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A home whose ~ the daemon and its adapters expand, and a stand-in claude
// that logs each start's arguments.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-spawn-plugin-dirs-');
  const home = join(temporaryDirectory.path, 'home');

  mkdirSync(home);

  return {
    directory: temporaryDirectory.path,
    home,
    fakeClaude: createStubRecordingClaude(join(temporaryDirectory.path, 'bin')),
    starts: join(temporaryDirectory.path, 'bin', 'claude-starts.log'),
  };
}

test("it starts claude with each of the spawn's plugin folders, ~ expanded, after atc's mod", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/plugins/band'],
    prompt: 'start the task',
  });

  const argv = await waitFor(() => {
    const log = readFileSync(ctx.starts, 'utf8');

    expect(log).toEndWith('\n\n');

    return log.trimEnd().split('\n');
  });

  expect(argv.slice(-5)).toStrictEqual([
    '--plugin-dir',
    expect.toEndWith('atc-bridge'),
    '--plugin-dir',
    join(ctx.home, 'plugins', 'band'),
    'start the task',
  ]);
});

test("it starts a sub-session with the config's plugin folders and its own spawn's, not its parent's", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.home, 'plugins', 'parent'), { recursive: true });
  mkdirSync(join(ctx.home, 'plugins', 'child'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: ['~/plugins/shared'] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/plugins/parent'],
    prompt: 'lead the task',
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    parent: getRecord(parent, 'session')['id'],
    pluginDirs: ['~/plugins/child'],
    prompt: 'help with the task',
  });

  const child = await waitFor(() => {
    const starts = readFileSync(ctx.starts, 'utf8').split('\n\n');

    expect(starts).toHaveLength(3);

    return starts
      .map((start) => start.split('\n'))
      .find((argv) => argv.at(-1) === 'help with the task');
  });

  invariant(child);

  expect(child.slice(-7)).toStrictEqual([
    '--plugin-dir',
    expect.toEndWith('atc-bridge'),
    '--plugin-dir',
    join(ctx.home, 'plugins', 'shared'),
    '--plugin-dir',
    join(ctx.home, 'plugins', 'child'),
    'help with the task',
  ]);
});

test("it starts every session of a claude entry with the config's plugin folders, and a spawn's own add to them", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.directory, 'extra'));

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: ['~/plugins/shared'] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  await daemon.client.sendRequest('session.spawn', { cwd: ctx.directory, prompt: 'first' });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: [join(ctx.directory, 'extra')],
    prompt: 'second',
  });

  const starts = await waitFor(() => {
    const log = readFileSync(ctx.starts, 'utf8');

    expect(log.split('\n\n')).toHaveLength(3);

    return log.trimEnd().split('\n\n');
  });

  const tails = starts.map((start) => {
    const argv = start.split('\n');

    return argv.slice(argv.indexOf('--plugin-dir'));
  });

  expect(tails).toIncludeSameMembers([
    [
      '--plugin-dir',
      expect.toEndWith('atc-bridge'),
      '--plugin-dir',
      join(ctx.home, 'plugins', 'shared'),
      'first',
    ],
    [
      '--plugin-dir',
      expect.toEndWith('atc-bridge'),
      '--plugin-dir',
      join(ctx.home, 'plugins', 'shared'),
      '--plugin-dir',
      join(ctx.directory, 'extra'),
      'second',
    ],
  ]);
});

test("it starts a Claude-compatible gateway with the config's plugin folders and the spawn's own", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.directory, 'extra'));

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: {
            zai: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              apiKeyHelper: 'op read op://vault/zai/key',
              pluginDirs: ['~/plugins/shared'],
            },
          },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'zai',
    pluginDirs: [join(ctx.directory, 'extra')],
    prompt: 'start the task',
  });

  const argv = await waitFor(() => {
    const log = readFileSync(ctx.starts, 'utf8');

    expect(log).toEndWith('\n\n');

    return log.trimEnd().split('\n');
  });

  expect(argv.slice(-7)).toStrictEqual([
    '--plugin-dir',
    expect.toEndWith('atc-bridge'),
    '--plugin-dir',
    join(ctx.home, 'plugins', 'shared'),
    '--plugin-dir',
    join(ctx.directory, 'extra'),
    'start the task',
  ]);
});

test('it refuses a spawn whose plugin folder does not exist, naming the path, and starts nothing', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/plugins/missing'],
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(ctx.home, 'plugins', 'missing')}' does not exist`,
  });

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a spawn whose plugin folder is a regular file, naming the path, and starts nothing', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.home, 'notes.txt'), 'not a plugin');

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/notes.txt'],
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(ctx.home, 'notes.txt')}' is not a folder`,
  });

  expect(listed).toStrictEqual({ sessions: [] });
});

test("it refuses a spawn when a plugin folder the agent's config sets is a regular file, naming the path", async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'shared.txt'), 'not a plugin');

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: {
            claude: { bin: ctx.fakeClaude, pluginDirs: [join(ctx.directory, 'shared.txt')] },
          },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: ctx.directory });

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(ctx.directory, 'shared.txt')}' is not a folder`,
  });
});

test("it loads a folder once when the spawn names one the agent's config sets, with a trailing slash", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: ['~/plugins/band'] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: [`${join(ctx.home, 'plugins', 'band')}/`],
    prompt: 'start the task',
  });

  const argv = await waitFor(() => {
    const log = readFileSync(ctx.starts, 'utf8');

    expect(log).toEndWith('\n\n');

    return log.trimEnd().split('\n');
  });

  expect(argv.slice(-5)).toStrictEqual([
    '--plugin-dir',
    expect.toEndWith('atc-bridge'),
    '--plugin-dir',
    join(ctx.home, 'plugins', 'band'),
    'start the task',
  ]);
});

test("it refuses a spawn when a plugin folder the agent's config sets does not exist, naming the path", async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: ['/nonexistent/plugins/shared'] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: ctx.directory });

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: "plugin folder '/nonexistent/plugins/shared' does not exist",
  });
});

test('it refuses to start a session again once its plugin folder is gone, naming the path', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    resume: 'sess-123',
    pluginDirs: ['~/plugins/band'],
  });

  const session = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.kill', { session, stopOnly: true });

  rmSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const adopt = daemon.client.sendRequest('session.adopt', { session, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(ctx.home, 'plugins', 'band')}' does not exist`,
  });
});

test.each([
  ['a relative plugin folder', 'plugins/band'],
  ['a plugin folder with a .. segment', '~/plugins/link/../band'],
])('it refuses %s before spawning anything', async (_label, directory) => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: [directory],
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `pluginDirs entry '${directory}' must be an absolute path or start with ~/, without a .. segment`,
  });

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses plugin folders for an agent that takes none', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude }, grok: { kind: 'grok', bin: 'sh' } },
        }),
        buildMockHostServices(),
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    agent: 'grok',
    pluginDirs: [ctx.directory],
  });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'grok' takes no pluginDirs",
  });
});

test('it refuses plugin folders on a target that runs the agent on another machine', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: (paths) => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
      ),
      targets: [
        {
          id: LOCAL_TARGET.id,
          kind: LOCAL_TARGET.provider,
          options: LOCAL_TARGET.options,
          identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
          provider: createLocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: createImpProvider(
            createStubImpPort(),
            { guestDir: join(paths.directory, 'g') },
            { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
          ),
        },
      ],
      defaultTarget: LOCAL_TARGET.id,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/work',
    target: 'box',
    pluginDirs: [ctx.directory],
  });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message:
      "target 'box' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them",
  });
});

test("it refuses a spawn on a target that runs the agent on another machine when only the agent's config sets plugin folders, and starts nothing there", async () => {
  const ctx = setupTest();
  const port = createStubImpPort();

  const daemon = await startTestDaemon({
    options: (paths) => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: [ctx.directory] } },
        }),
        buildMockHostServices(),
      ),
      targets: [
        {
          id: LOCAL_TARGET.id,
          kind: LOCAL_TARGET.provider,
          options: LOCAL_TARGET.options,
          identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
          provider: createLocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: createImpProvider(
            port,
            { guestDir: join(paths.directory, 'g') },
            { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
          ),
        },
      ],
      defaultTarget: LOCAL_TARGET.id,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/work', target: 'box' });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message:
      "target 'box' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them",
  });

  expect(listed).toStrictEqual({ sessions: [] });
  expect(port.calls).toStrictEqual([]);
});

test('it shows the plugin folders a session was spawned with in its record', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: ctx.fakeClaude } } }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/plugins/band'],
  });

  const record = await daemon.client.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(getRecord(record, 'session')['pluginDirs']).toStrictEqual([
    join(ctx.home, 'plugins', 'band'),
  ]);
});

test("it keeps the config's plugin folders and the session's own in the command that resumes it outside atc", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.home, 'plugins', 'band'), { recursive: true });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: ['~/plugins/shared'] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.directory,
    pluginDirs: ['~/plugins/band'],
  });

  const answer = await daemon.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(answer['command']).toInclude(
    ` --plugin-dir '${join(ctx.home, 'plugins', 'shared')}' --plugin-dir '${join(ctx.home, 'plugins', 'band')}' --resume`,
  );
});

test('it lists plugin folders as a spawn option of claude and not of grok', async () => {
  const ctx = setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude }, grok: { kind: 'grok', bin: ctx.fakeClaude } },
        }),
        buildMockHostServices(),
      ),
    }),
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(
    getRecords(listed, 'agents').map((agent) => [
      agent['id'],
      getRecord(agent, 'spawnOptions')['pluginDirs'],
    ]),
  ).toStrictEqual([
    [
      'claude',
      {
        supported: true,
        values: null,
        examples: [],
        default: null,
        backendEffect: 'applied',
        note: "Each folder passed as --plugin-dir, after the folders the agent's config sets. An absolute path or one that starts with ~/ on the daemon's machine, without a .. segment; a path that does not exist or is not a folder, or a remote target, refuses the spawn.",
        available: true,
      },
    ],
    [
      'grok',
      {
        supported: false,
        values: null,
        examples: [],
        default: null,
        backendEffect: null,
        note: null,
        available: false,
      },
    ],
  ]);
});
