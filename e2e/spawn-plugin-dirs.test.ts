import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_TARGET, parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { LocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';
import {
  buildMockHostServices,
  createStubRecordingClaude,
  getRecord,
  getRecords,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A home whose ~ the daemon and its adapters expand, and a stand-in claude
// that logs each start's arguments.
function setupTest() {
  const tmp = setupTempDir('atc-spawn-plugin-dirs-');
  const home = join(tmp.dir, 'home');

  mkdirSync(home);

  return {
    dir: tmp.dir,
    home,
    fakeClaude: createStubRecordingClaude(join(tmp.dir, 'bin')),
    starts: join(tmp.dir, 'bin', 'claude-starts.log'),
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
    cwd: ctx.dir,
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

test("it starts every session of a claude entry with the config's plugin folders, and a spawn's own add to them", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.dir, 'extra'));

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

  await daemon.client.sendRequest('session.spawn', { cwd: ctx.dir, prompt: 'first' });

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    pluginDirs: [join(ctx.dir, 'extra')],
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
      join(ctx.dir, 'extra'),
      'second',
    ],
  ]);
});

test("it starts a Claude-compatible gateway with the config's plugin folders and the spawn's own", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, 'plugins', 'shared'), { recursive: true });
  mkdirSync(join(ctx.dir, 'extra'));

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
    cwd: ctx.dir,
    agent: 'zai',
    pluginDirs: [join(ctx.dir, 'extra')],
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
    join(ctx.dir, 'extra'),
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
    cwd: ctx.dir,
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
    cwd: ctx.dir,
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

  writeFileSync(join(ctx.dir, 'shared.txt'), 'not a plugin');

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: [join(ctx.dir, 'shared.txt')] } },
        }),
        buildMockHostServices(),
        null,
        { homeDir: ctx.home },
      ),
      homeDir: ctx.home,
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `plugin folder '${join(ctx.dir, 'shared.txt')}' is not a folder`,
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
    cwd: ctx.dir,
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

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: ctx.dir });

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
    cwd: ctx.dir,
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
])('it refuses %s before spawning anything', async (_label, dir) => {
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
    cwd: ctx.dir,
    pluginDirs: [dir],
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: `pluginDirs entry '${dir}' must be an absolute path or start with ~/, without a .. segment`,
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
    cwd: ctx.dir,
    agent: 'grok',
    pluginDirs: [ctx.dir],
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
          provider: new LocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            createStubImpPort(),
            { guestDir: join(paths.dir, 'g') },
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
    pluginDirs: [ctx.dir],
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
          agents: { claude: { bin: ctx.fakeClaude, pluginDirs: [ctx.dir] } },
        }),
        buildMockHostServices(),
      ),
      targets: [
        {
          id: LOCAL_TARGET.id,
          kind: LOCAL_TARGET.provider,
          options: LOCAL_TARGET.options,
          identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
          provider: new LocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            port,
            { guestDir: join(paths.dir, 'g') },
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
    cwd: ctx.dir,
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
    cwd: ctx.dir,
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
