import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import {
  KEYS,
  buildMockAgentEntry,
  buildMockHostServices,
  getAgentEntry,
  runCommand,
  setupTempDir,
} from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { ATC_BRIDGE_FILES } from './bridge/atc-bridge-files';
import { CLAUDE_PLUGIN } from './claude-plugin';
import { createClaudeAdapter } from './create-claude-adapter';
import { buildStubClaudeHeadlessRun } from './testing/build-stub-claude-headless-run';

// A folder for the files a test writes: transcripts, the atc-bridge mod, a
// host config folder, or a guest folder a launch runs in.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-claude-adapter-');

  return { directory: temporaryDirectory.path };
}

test("it reads a session's hook lines as Claude's, with no state across them", () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = adapter.planHookEvents({
    atcId: toSessionID('s1'),
    event: 'SessionEnd',
    payload: { session_id: 'c-1' },
  });

  expect(plan).toStrictEqual({
    events: [{ kind: 'ended', agentSessionID: toAgentSessionID('c-1') }],
  });
});

test('it takes inbox messages', () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.takesMessages).toBeTrue();
});

test('it runs a headless turn through the configured claude binary under the auto permission mode with the atc-bridge mod', () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      headlessRun: runner,
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const events = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  adapter.headlessRunner?.(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      model: 'opus',
      effort: 'high',
    },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      model: 'opus',
      effort: 'high',
      claudeBin: 'claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-claude.json'),
    },
    events,
  );
});

test('it advertises the documented model aliases and effort levels with the configured defaults', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { args: ['--model', 'opus', '--effort=high'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.profile.spawnOptions).toStrictEqual({
    model: {
      supported: true,
      values: null,
      examples: [
        { value: 'best', resolvesTo: null },
        { value: 'fable', resolvesTo: null },
        { value: 'opus', resolvesTo: null },
        { value: 'sonnet', resolvesTo: null },
        { value: 'haiku', resolvesTo: null },
        { value: 'opus[1m]', resolvesTo: null },
        { value: 'sonnet[1m]', resolvesTo: null },
        { value: 'opusplan', resolvesTo: null },
      ],
      default: 'opus',
      backendEffect: 'applied',
      note: 'An alias or a full model name, passed as --model.',
    },
    effort: {
      supported: true,
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
      examples: [],
      default: 'high',
      backendEffect: 'applied',
      note: 'Passed as --effort. Which levels a session honours depends on its model.',
    },
    pluginDirs: {
      supported: true,
      values: null,
      examples: [],
      default: null,
      backendEffect: 'applied',
      note: "Each folder passed as --plugin-dir, after the folders the agent's config sets. An absolute path or one that starts with ~/ on the daemon's machine, without a .. segment; a path that does not exist or is not a folder, or a remote target, refuses the spawn.",
    },
  });
});

test('it advertises no default model or effort when the configured arguments set none', () => {
  const options = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  ).profile.spawnOptions;

  expect(options.model.default).toBeNull();
  expect(options.effort.default).toBeNull();
});

test('it runs a headless turn under the permission mode its configured arguments set', () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { args: ['--permission-mode', 'plan'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    {
      headlessRun: runner,
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const events = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: 'claude',
      permissionMode: 'plan',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-claude.json'),
    },
    events,
  );
});

test('it keeps the permission mode its configured arguments set in the command that resumes it outside atc', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { args: ['--permission-mode', 'plan'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), [])).toBe(
    "cd '/work/repo' && claude --permission-mode 'plan' --resume sess-1",
  );
});

test('it restores a stock session in the mode its settings set', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { settings: { permissions: { defaultMode: 'bypassPermissions' } } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it gives a local session a scratch folder of its own as a working directory and its temporary folder', () => {
  const ctx = setupTest();
  const config = parseConfig([CLAUDE_PLUGIN], {});

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: 'hi', resume: false }, toSessionID('s1'));

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--add-dir',
      join(ctx.directory, 'state', 'sessions', 's1', 'scratch'),
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
      'hi',
    ],
    env: { TMPDIR: join(ctx.directory, 'state', 'sessions', 's1', 'scratch') },
  });

  expect(existsSync(join(ctx.directory, 'state', 'sessions', 's1', 'scratch'))).toBeTrue();
});

test("it loads the config's plugin folders with ~ expanded, then the session's own, after atc's mod", () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { pluginDirs: ['~/plugins/band', '/opt/plugins/shared'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({
    prompt: '',
    resume: false,
    pluginDirs: ['/srv/plugins/extra', '/opt/plugins/shared'],
  });

  expect(plan.args).toStrictEqual([
    '--settings',
    join(ctx.directory, 'state', 'hook-settings-claude.json'),
    '--plugin-dir',
    join(ctx.directory, 'atc-bridge'),
    '--plugin-dir',
    join(ctx.directory, 'home', 'plugins', 'band'),
    '--plugin-dir',
    '/opt/plugins/shared',
    '--plugin-dir',
    '/srv/plugins/extra',
  ]);
});

test("it lists the config's plugin folders with ~ expanded in its profile", () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { pluginDirs: ['~/plugins/band', '/opt/plugins/shared'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  expect(adapter.profile.pluginDirs).toStrictEqual([
    join(ctx.directory, 'home', 'plugins', 'band'),
    '/opt/plugins/shared',
  ]);
});

test('it lists no plugin folders in the profile of an entry whose config sets none', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {});

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.profile.pluginDirs).toBeUndefined();
});

test("it leaves the config's and the session's plugin folders out of a remote spawn", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { pluginDirs: ['/opt/plugins/shared'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false, pluginDirs: ['/srv/plugins/extra'] },
    { atc: '/opt/atc/bin/atc', directory: '/tmp/atc/sessions/s1' },
  );

  expect(plan?.args).toStrictEqual([
    '-c',
    expect.toBeString(),
    'sh',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);
});

test("it runs a headless turn with the config's plugin folders and then the session's own", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { pluginDirs: ['/opt/plugins/shared'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    {
      headlessRun: runner,
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const events = { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} };

  adapter.headlessRunner?.(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      pluginDirs: ['/srv/plugins/extra'],
    },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      pluginDirs: ['/opt/plugins/shared', '/srv/plugins/extra'],
      claudeBin: 'claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-claude.json'),
    },
    events,
  );
});

test('it plans the guest bridge files a remote session launches with', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {});

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.planGuestBridgeFiles('/opt/atc/bin/atc')).toStrictEqual({
    'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
    'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
    'atc-bridge/hooks/atc-cli.ts':
      'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  });
});

test('it restores an unbrokered remote session in the mode its settings set', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { settings: { permissions: { defaultMode: 'plan' } } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('sess-1') },
    { atc: '/opt/atc/bin/atc', directory: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'sh',
    args: [
      '-c',
      expect.toBeString(),
      'sh',
      '/tmp/atc/sessions/s1/scratch',
      'claude',
      '--permission-mode',
      'plan',
      '--add-dir',
      '/tmp/atc/sessions/s1/scratch',
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
      '--resume',
      'sess-1',
    ],
    env: { TMPDIR: '/tmp/atc/sessions/s1/scratch' },
    files: {
      'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
      'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
      'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
      'atc-bridge/hooks/atc-cli.ts':
        'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
      'settings.json': expect.toBeString(),
    },
  });

  const settingsFile = plan?.files['settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the settings file');

  expect(JSON.parse(settingsFile)).toStrictEqual({
    permissions: { defaultMode: 'plan' },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 0,
    },
  });
});

test('it plans a remote spawn in the permission mode its configured arguments set', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { args: ['--permission-mode', 'plan'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: '/opt/atc/bin/atc', directory: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'sh',
    args: [
      '-c',
      expect.toBeString(),
      'sh',
      '/tmp/atc/sessions/s1/scratch',
      'claude',
      '--permission-mode',
      'plan',
      '--add-dir',
      '/tmp/atc/sessions/s1/scratch',
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    env: { TMPDIR: '/tmp/atc/sessions/s1/scratch' },
    files: {
      'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
      'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
      'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
      'atc-bridge/hooks/atc-cli.ts':
        'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
      'settings.json': expect.toBeString(),
    },
  });

  const settingsFile = plan?.files['settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the settings file');

  expect(JSON.parse(settingsFile)).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 0,
    },
  });
});

test('it quotes a configured binary path with spaces in the resume command', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { bin: '/opt/Claude Code/claude' } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), [])).toBe(
    "cd '/work/repo' && '/opt/Claude Code/claude' --resume sess-1",
  );
});

test('it carries the settings file in the resume command of an entry with its own settings', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { settings: { model: 'opus' } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices({ atcArgv: ['/opt/atc/bin/atc'] }),
    { stateDir: join(ctx.directory, 'state'), homeDir: join(ctx.directory, 'home') },
  );

  const command = adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), []);

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-claude.json'), 'utf8'),
  );

  expect(command).toBe(
    `cd '/work/repo' && claude --settings '${join(ctx.directory, 'state', 'hook-settings-claude.json')}' --resume sess-1`,
  );

  expect(settings).toStrictEqual({
    model: 'opus',
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: `"/opt/atc/bin/atc" statusline --agent='claude'`,
      padding: 0,
    },
  });
});

test('it restores a stock session without a permission-mode argument', () => {
  const ctx = setupTest();

  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it resumes a stock session outside atc without a permission-mode argument', () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), [])).toBe(
    "cd '/work/repo' && claude --resume sess-1",
  );
});

test("it keeps the config's plugin folders and the session's own in the command that resumes it outside atc", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: { claude: { pluginDirs: ['/opt/plugins/shared'] } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(
    adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), ['/srv/plugins/band']),
  ).toBe(
    "cd '/work/repo' && claude --plugin-dir '/opt/plugins/shared' --plugin-dir '/srv/plugins/band' --resume sess-1",
  );
});

test('it pastes a long line and submits it with a carriage return as a second write', () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.planLineInput('a'.repeat(1600), { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}${'a'.repeat(1600)}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it takes no credential from the broker when the config holds no Claude auth', () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it seeds no clone trust when the config holds no Claude auth', () => {
  const adapter = createClaudeAdapter(
    getAgentEntry(parseConfig([CLAUDE_PLUGIN], {}), 'claude'),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.planGuestWorkspaceTrust('/work/repo')).toBeNull();
});

test('it selects the subscription token on the Anthropic API with the placeholder, and still starts where no broker is', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'claude',
      baseURL: 'https://api.anthropic.com',
      auth: {
        profiles: ['claude'],
        placeholderEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
      },
    },
    profiles: config.authProfiles,
    brokerRequired: false,
  });
});

test("it selects the entry's own placeholders beside the subscription token's", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      jev: {
        secret: 'jev-agents',
        host: 'api.typesafe.ai',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: {
      claude: {
        auth: {
          profiles: ['claude', 'jev'],
          placeholderEnv: { TYPESAFE_API_KEY: { profile: 'jev' } },
        },
      },
    },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'claude',
      baseURL: 'https://api.anthropic.com',
      auth: {
        profiles: ['claude', 'jev'],
        placeholderEnv: {
          TYPESAFE_API_KEY: 'broker-placeholder',
          CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
        },
      },
    },
    profiles: config.authProfiles,
    brokerRequired: false,
  });
});

test('it plans a subscription guest spawn with its own config folder, the placeholder, and no permission mode', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: {
      claude: {
        args: ['--permission-mode', 'plan', '--verbose'],
        auth: { profiles: ['claude'] },
      },
    },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const settingsFile = plan.files['auth-r2/settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the revision settings file');

  const settings: unknown = JSON.parse(settingsFile);

  // The launch script is pinned by the guest launch's own tests.
  const args: readonly unknown[] = plan.args;

  expect({ bin: plan.bin, args, env: plan.env }).toStrictEqual({
    bin: 'sh',
    args: [
      '-c',
      expect.any(String),
      'sh',
      '/tmp/atc/sessions/s1/claude-config',
      '/tmp/atc/sessions/s1/claude-config-seed.json',
      '/tmp/atc/sessions/s1/claude-config-bundle',
      expect.stringMatching(/^\/tmp\/atc\/sessions\/s1\/claude-config-bundle\/[\da-f-]{36}$/u),
      '/tmp/atc/sessions/s1/scratch',
      'claude',
      '--verbose',
      '--add-dir',
      '/tmp/atc/sessions/s1/scratch',
      '--settings',
      '/tmp/atc/sessions/s1/auth-r2/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
      'hi',
    ],
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      TMPDIR: '/tmp/atc/sessions/s1/scratch',
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
    },
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 0,
    },
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  const seed = plan.files['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected a seed file');

  expect(JSON.parse(seed)).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test("it ships the host's Claude config as the session's user settings and keeps it out of the --settings file", () => {
  const ctx = setupTest();
  const claudeDir = join(ctx.directory, 'home', '.claude');

  mkdirSync(join(claudeDir, 'skills', 'delegate'), { recursive: true });
  writeFileSync(join(claudeDir, 'skills', 'delegate', 'SKILL.md'), 'delegate');
  writeFileSync(join(claudeDir, 'statusline.sh'), 'echo status');

  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify({
      outputStyle: 'STE Direct',
      model: 'opus[1m]',
      statusLine: { type: 'command', command: `bash "${claudeDir}/statusline.sh"`, padding: 2 },
    }),
  );

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const bundleDir = plan.args.at(6);

  invariant(bundleDir !== undefined, 'expected the staged bundle folder in the launch');

  const bundleKey = bundleDir.replace('/tmp/atc/sessions/s1/', '');
  const userSettings = plan.files[`${bundleKey}/settings.json`];
  const flagSettings = plan.files['auth-r1/settings.json'];

  invariant(
    typeof userSettings === 'string' && typeof flagSettings === 'string',
    'expected the bundle and revision settings files',
  );

  expect(JSON.parse(userSettings)).toStrictEqual({
    model: 'opus[1m]',
    outputStyle: 'STE Direct',
    statusLine: {
      type: 'command',
      command: 'bash "/tmp/atc/sessions/s1/claude-config/statusline.sh"',
      padding: 2,
    },
    permissions: {
      deny: [
        'Read(//tmp/atc/sessions/s1/claude-config/.claude.json)',
        'Read(~/.claude/.credentials.json)',
      ],
      defaultMode: 'auto',
    },
  });

  expect(JSON.parse(flagSettings)).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 2,
    },
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  expect(plan.files).toContainAllKeys([
    'auth-r1/settings.json',
    'claude-config-seed.json',
    `${bundleKey}/.credentials.json`,
    `${bundleKey}/settings.json`,
    `${bundleKey}/statusline.sh`,
    `${bundleKey}/skills/delegate/SKILL.md`,
    'atc-bridge/.claude-plugin/plugin.json',
    'atc-bridge/hooks/hooks.json',
    'atc-bridge/hooks/register.ts',
    'atc-bridge/hooks/atc-cli.ts',
  ]);
});

test('it gives a subscription guest spawn its MCP servers with the placeholder in an MCP config of its binding revision', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      linear: {
        secret: 'linear-agents',
        host: 'mcp.linear.app',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: {
      claude: {
        auth: {
          profiles: ['claude', 'linear'],
          mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', profile: 'linear' } },
        },
      },
    },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const mcpConfig = plan.files['auth-r3/mcp.json'];

  invariant(typeof mcpConfig === 'string', 'expected the revision MCP config file');

  // The launch script is pinned by the guest launch's own tests.
  const args: readonly unknown[] = plan.args;

  expect(args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    expect.stringMatching(/^\/tmp\/atc\/sessions\/s1\/claude-config-bundle\/[\da-f-]{36}$/u),
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--mcp-config',
    '/tmp/atc/sessions/s1/auth-r3/mcp.json',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r3/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
    'hi',
  ]);

  expect(JSON.parse(mcpConfig)).toStrictEqual({
    mcpServers: {
      linear: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { authorization: 'Bearer broker-placeholder' },
      },
    },
  });
});

test('it plans a guest spawn without a broker binding in the config of the host image', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: '/opt/atc/bin/atc', directory: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'sh',
    args: [
      '-c',
      expect.toBeString(),
      'sh',
      '/tmp/atc/sessions/s1/scratch',
      'claude',
      '--add-dir',
      '/tmp/atc/sessions/s1/scratch',
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    env: { TMPDIR: '/tmp/atc/sessions/s1/scratch' },
    files: {
      'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
      'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
      'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
      'atc-bridge/hooks/atc-cli.ts':
        'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
      'settings.json': expect.toBeString(),
    },
  });

  const settingsFile = plan?.files['settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the settings file');

  expect(JSON.parse(settingsFile)).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 0,
    },
  });
});

test.each([
  ['ANTHROPIC_API_KEY'],
  ['ANTHROPIC_AUTH_TOKEN'],
  ['ANTHROPIC_BASE_URL'],
  ['CLAUDE_CODE_USE_VERTEX'],
  ['HTTPS_PROXY'],
])('it refuses a subscription guest spawn whose configured --settings sets %s', (variable) => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: {
      claude: {
        args: ['--settings', JSON.stringify({ env: { [variable]: 'sk-test' } })],
        auth: { profiles: ['claude'] },
      },
    },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      data: { agent: 'claude', problem: 'guest_env_conflict', variable },
    }),
  );
});

test('it refuses a subscription guest spawn whose entry env overrides the sign-in', () => {
  const adapter = createClaudeAdapter(
    buildMockAgentEntry({
      id: 'claude',
      bin: 'claude',
      env: { ANTHROPIC_BASE_URL: 'https://x.example.com' },
      auth: { profiles: ['claude'], placeholderEnv: {} },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      message:
        "claude signs in through this target's broker, but agents.claude.env sets ANTHROPIC_BASE_URL, which would override or route around that sign-in",
      data: { agent: 'claude', problem: 'guest_env_conflict', variable: 'ANTHROPIC_BASE_URL' },
    }),
  );
});

test('it refuses a subscription guest spawn whose entry settings env overrides the sign-in', () => {
  const adapter = createClaudeAdapter(
    buildMockAgentEntry({
      id: 'claude',
      bin: 'claude',
      settings: { env: { HTTPS_PROXY: 'http://p.example:3128' } },
      auth: { profiles: ['claude'], placeholderEnv: {} },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      message:
        "claude signs in through this target's broker, but agents.claude.settings.env sets HTTPS_PROXY, which would override or route around that sign-in",
      data: { agent: 'claude', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
    }),
  );
});

test('it refuses to start a subscription session in a host whose environment sets ANTHROPIC_API_KEY', async () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { bin: 'true', auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: ctx.directory,
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const seed = plan.files['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected the seed file');
  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), seed);

  const run = await runCommand([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env, ANTHROPIC_API_KEY: 'sk-test' },
  });

  expect({ exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }).toStrictEqual({
    exitCode: 78,
    stdout: '',
    stderr:
      "atc: ANTHROPIC_API_KEY is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start\n",
  });

  expect(existsSync(join(ctx.directory, 'claude-config'))).toBeFalse();
});

test.each([
  ['ANTHROPIC_BASE_URL', 'https://proxy.example'],
  ['CLAUDE_CODE_USE_BEDROCK', '1'],
  ['CLAUDE_CODE_USE_VERTEX', '1'],
  ['CLAUDE_CODE_USE_FOUNDRY', '1'],
  ['CLAUDE_CODE_USE_MANTLE', '1'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', '1'],
  ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', '1'],
  ['CLAUDE_CODE_USE_GATEWAY', '1'],
])(
  'it refuses to start a subscription session in a host whose environment sets %s',
  async (name, value) => {
    const ctx = setupTest();

    const config = parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        claude: {
          secret: 'claude-setup-token',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
      agents: { claude: { bin: 'true', auth: { profiles: ['claude'] } } },
    });

    const adapter = createClaudeAdapter(
      getAgentEntry(config, 'claude'),
      config,
      buildMockHostServices(),
      { homeDir: join(ctx.directory, 'home') },
    );

    const plan = adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: ctx.directory,
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    );

    invariant(plan !== null, 'expected a guest spawn plan');

    const run = await runCommand([plan.bin, ...plan.args], {
      env: { PATH: process.env['PATH'] ?? '', ...plan.env, [name]: value },
    });

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toStrictEqual({
      exitCode: 78,
      stderr: `atc: ${name} is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start\n`,
    });
  },
);

test('it starts a subscription session with a seeded config folder in a host whose environment sets no credential', async () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { bin: 'true', auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: ctx.directory,
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const seed = plan.files['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected the seed file');
  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), seed);

  const run = await runCommand([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env },
  });

  const seeded = readFileSync(join(ctx.directory, 'claude-config', '.claude.json'), 'utf8');

  expect(run.exitCode).toBe(0);

  expect(JSON.parse(seeded)).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test("it seeds folder trust and approval of the clone's own MCP servers for the exact clone root of a subscription session", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
  );

  const seed = adapter.planGuestWorkspaceTrust('/work/repo')?.['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected a seed file');

  expect(JSON.parse(seed)).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { '/work/repo': { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });
});

test("it sets a profile's variables in a subscription guest's settings env and spawn env", () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
        env: {
          OP_CONNECT_HOST: 'https://op-connect.example.com',
          OP_CONNECT_TOKEN: 'broker-placeholder',
        },
      },
    },
    agents: { claude: { auth: { profiles: ['claude', 'op'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {
          OP_CONNECT_HOST: 'https://op-connect.example.com',
          OP_CONNECT_TOKEN: 'broker-placeholder',
        },
      },
    },
  );

  const settingsFile = plan?.files['auth-r2/settings.json'];

  invariant(
    plan !== null && typeof settingsFile === 'string',
    'expected a guest spawn plan with a settings file',
  );

  const settings: unknown = JSON.parse(settingsFile);

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    OP_CONNECT_HOST: 'https://op-connect.example.com',
    OP_CONNECT_TOKEN: 'broker-placeholder',
    CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'claude\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'',
      padding: 0,
    },
    env: {
      OP_CONNECT_HOST: 'https://op-connect.example.com',
      OP_CONNECT_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test("it leaves a profile's variables out of the local plan of an entry with a profile env", () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      op: {
        secret: 'op-connect',
        host: 'op-connect.example.com',
        header: 'authorization',
        scheme: 'bearer',
        env: {
          OP_CONNECT_HOST: 'https://op-connect.example.com',
          OP_CONNECT_TOKEN: 'broker-placeholder',
        },
      },
    },
    agents: { claude: { auth: { profiles: ['claude', 'op'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices({ atcArgv: ['/opt/atc/bin/atc'] }),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-claude.json'), 'utf8'),
  );

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
    ],
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='claude'`,
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: `"/opt/atc/bin/atc" statusline --agent='claude'`,
      padding: 0,
    },
  });
});

test('it plans a Codex home in the binding revision when the profiles send a ready ChatGPT sign-in', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude', 'codex'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
        oauth: {
          'codex-chatgpt': {
            status: 'ready',
            idClaims: {
              email: 'someone@example.com',
              'https://api.openai.com/auth': {
                chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
              },
              sub: 'user-1',
            },
          },
        },
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const authFile = plan.files['auth-r2/codex-home/auth.json'];

  invariant(
    typeof authFile === 'object' && 'mode' in authFile,
    'expected the Codex sign-in file with its mode',
  );

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    CODEX_HOME: '/tmp/atc/sessions/s1/auth-r2/codex-home',
    CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
  });

  expect(plan.args[1]).toInclude('unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN; ');
  expect(authFile.mode).toBe(0o600);

  expect(plan.files['auth-r2/codex-home/config.toml']).toBe(
    'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
  );

  expect(JSON.parse(new TextDecoder().decode(authFile.content))).toStrictEqual({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token:
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InNvbWVvbmVAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiNWYwYzFkN2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDBjMGRlIn19.YnJva2VyLXBsYWNlaG9sZGVy',
      access_token: 'broker-placeholder',
      refresh_token: 'broker-placeholder',
      account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
    },
    last_refresh: '2099-01-01T00:00:00Z',
  });
});

test('it plans no Codex home when the ChatGPT sign-in in the broker is not ready', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    agents: { claude: { auth: { profiles: ['claude', 'codex'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
        oauth: { 'codex-chatgpt': { status: 'needs_login', idClaims: null } },
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
  });

  const [, script] = plan.args;

  invariant(script !== undefined, 'expected the launch script');

  expect(Object.keys(plan.files).filter((path) => path.includes('codex-home'))).toBeEmpty();
  expect(script).not.toInclude('unset ');
});

test('it plans no Codex home when a ChatGPT profile sets no bearer authorization header', () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'x-api-key',
        scheme: 'raw',
      },
    },
    agents: { claude: { auth: { profiles: ['claude', 'codex'] } } },
  });

  const adapter = createClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    buildMockHostServices(),
    { homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
        oauth: {
          'codex-chatgpt': {
            status: 'ready',
            idClaims: {
              'https://api.openai.com/auth': {
                chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
              },
            },
          },
        },
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
  });

  expect(Object.keys(plan.files).filter((path) => path.includes('codex-home'))).toBeEmpty();
});
