import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMockAgentEntry } from '../test-utils/build-mock-agent-entry';
import { buildStubClaudeHeadlessRun } from '../test-utils/build-stub-claude-headless-run';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { KEYS } from '../test-utils/keys';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { ClaudeAdapter } from './claude-adapter';

// A folder for the files a test writes: transcripts, the atc-bridge mod, a
// host config folder, or a guest folder a launch runs in.
function setupTest() {
  return setupTempDir('atc-claude-adapter-');
}

test('it resumes when no transcript was reported', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.canResume({})).toBeTrue();
});

test('it resumes when the reported transcript exists', () => {
  using ctx = setupTest();

  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.canResume({ transcriptSource: transcript })).toBeTrue();
});

test('it does not resume when the reported transcript is gone', () => {
  using ctx = setupTest();

  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.canResume({ transcriptSource: join(ctx.dir, 'missing.jsonl') })).toBeFalse();
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 42, transcript_path: null, last_assistant_message: ['pong'] },
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
  });

  expect(ev).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    detail: `${'x'.repeat(599)}…`,
    result: 'x'.repeat(700),
  });
});

test('it takes inbox messages', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.takesMessages).toBeTrue();
});

test('it runs a headless turn through the configured claude binary under the auto permission mode with the atc-bridge mod', () => {
  using ctx = setupTest();

  const runner = buildStubClaudeHeadlessRun();

  const adapter = new ClaudeAdapter(
    getAgentEntry(parseConfig({}), 'claude'),
    parseConfig({}),
    runner,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go', model: 'opus', effort: 'high' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      model: 'opus',
      effort: 'high',
      claudeBin: 'claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-claude.json'),
    },
    expect.anything(),
  );
});

test('it advertises the documented model aliases and effort levels with the configured defaults', () => {
  const config = parseConfig({ claudeArgs: ['--model', 'opus', '--effort=high'] });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

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
  });
});

test('it advertises no default model or effort when the configured arguments set none', () => {
  const options = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}))
    .profile.spawnOptions;

  expect([options.model.default, options.effort.default]).toStrictEqual([null, null]);
});

test('it runs a headless turn under the permission mode its configured arguments set', () => {
  using ctx = setupTest();

  const runner = buildStubClaudeHeadlessRun();
  const config = parseConfig({ claudeArgs: ['--permission-mode', 'plan'] });

  const adapter = new ClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    runner,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      claudeBin: 'claude',
      permissionMode: 'plan',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-claude.json'),
    },
    expect.anything(),
  );
});

test('it keeps the permission mode its configured arguments set in the command that resumes it outside atc', () => {
  const config = parseConfig({ claudeArgs: ['--permission-mode', 'plan'] });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  expect(adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'))).toBe(
    "cd '/work/repo' && claude --permission-mode 'plan' --resume sess-1",
  );
});

test('it restores a stock session in the mode its settings set', () => {
  using ctx = setupTest();

  const config = parseConfig({
    agents: { claude: { settings: { permissions: { defaultMode: 'bypassPermissions' } } } },
  });

  const adapter = new ClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it restores an unbrokered remote session in the mode its settings set', () => {
  const config = parseConfig({
    agents: { claude: { settings: { permissions: { defaultMode: 'plan' } } } },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('sess-1') },
    { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'plan',
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
      '--resume',
      'sess-1',
    ],
    files: expect.toContainAllKeys([
      'atc-bridge/.claude-plugin/plugin.json',
      'atc-bridge/hooks/hooks.json',
      'atc-bridge/hooks/register.ts',
      'atc-bridge/hooks/atc-cli.ts',
      'settings.json',
    ]),
  });
});

test('it plans a remote spawn in the permission mode its configured arguments set', () => {
  const config = parseConfig({ claudeArgs: ['--permission-mode', 'plan'] });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'plan',
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    files: expect.toContainAllKeys([
      'atc-bridge/.claude-plugin/plugin.json',
      'atc-bridge/hooks/hooks.json',
      'atc-bridge/hooks/register.ts',
      'atc-bridge/hooks/atc-cli.ts',
      'settings.json',
    ]),
  });
});

test('it quotes a configured binary path with spaces in the resume command', () => {
  const config = parseConfig({ agents: { claude: { bin: '/opt/Claude Code/claude' } } });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  expect(adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'))).toBe(
    "cd '/work/repo' && '/opt/Claude Code/claude' --resume sess-1",
  );
});

test('it carries the settings file in the resume command of an entry with its own settings', () => {
  using ctx = setupTest();

  const config = parseConfig({
    agents: { claude: { settings: { model: 'opus' } } },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    stateDir: join(ctx.dir, 'state'),
    homeDir: join(ctx.dir, 'home'),
  });

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.dir, 'state', 'hook-settings-claude.json'), 'utf8'),
  );

  expect({ command, settings }).toStrictEqual({
    command: `cd '/work/repo' && claude --settings '${join(ctx.dir, 'state', 'hook-settings-claude.json')}' --resume sess-1`,
    settings: {
      model: 'opus',
      hooks: expect.toContainAllKeys([
        'SessionStart',
        'Notification',
        'Stop',
        'UserPromptSubmit',
        'SessionEnd',
      ]),
      statusLine: {
        type: 'command',
        command: `"${process.execPath}" "${join(import.meta.dir, '..', 'cli.ts')}" statusline --agent 'claude'`,
        padding: 0,
      },
    },
  });
});

test('it restores a stock session without a permission-mode argument', () => {
  using ctx = setupTest();

  const adapter = new ClaudeAdapter(
    getAgentEntry(parseConfig({}), 'claude'),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it resumes a stock session outside atc without a permission-mode argument', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'))).toBe(
    "cd '/work/repo' && claude --resume sess-1",
  );
});

test('it pastes a long line and submits it with a carriage return as a second write', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.planLineInput('a'.repeat(1600), { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}${'a'.repeat(1600)}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it takes no credential from the broker when the config holds no claudeAuth', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it seeds no clone trust when the config holds no claudeAuth', () => {
  const adapter = new ClaudeAdapter(getAgentEntry(parseConfig({}), 'claude'), parseConfig({}));

  expect(adapter.planGuestWorkspaceTrust('/work/repo')).toBeNull();
});

test('it selects the subscription token on the Anthropic API with the placeholder, and still starts where no broker is', () => {
  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'claude',
      baseURL: 'https://api.anthropic.com',
      auth: {
        profiles: ['claude'],
        placeholderEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    profiles: config.authProfiles,
    brokerRequired: false,
  });
});

test('it plans a subscription guest spawn with its own config folder, the placeholder, and no permission mode', () => {
  using ctx = setupTest();

  const config = parseConfig({
    claudeArgs: ['--permission-mode', 'plan', '--verbose'],
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const settingsFile = plan.files['auth-r2/settings.json'];

  if (typeof settingsFile !== 'string') {
    throw new TypeError('expected the revision settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect(plan.args.at(6)).toMatch(
    /^\/tmp\/atc\/sessions\/s1\/claude-config-bundle\/[\da-f-]{36}$/u,
  );

  expect({
    bin: plan.bin,
    args: [...plan.args.slice(2, 6), ...plan.args.slice(7)],
    env: plan.env,
  }).toStrictEqual({
    bin: 'sh',
    args: [
      'sh',
      '/tmp/atc/sessions/s1/claude-config',
      '/tmp/atc/sessions/s1/claude-config-seed.json',
      '/tmp/atc/sessions/s1/claude-config-bundle',
      'claude',
      '--verbose',
      '--settings',
      '/tmp/atc/sessions/s1/auth-r2/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
      'hi',
    ],
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
    },
  });

  expect(settings).toStrictEqual({
    hooks: expect.toContainAllKeys([
      'SessionStart',
      'Notification',
      'Stop',
      'UserPromptSubmit',
      'SessionEnd',
    ]),
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent \'claude\'',
      padding: 0,
    },
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  const seed = plan.files['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected a seed file');
  }

  expect(JSON.parse(seed)).toStrictEqual({ hasCompletedOnboarding: true });
});

test("it ships the host's Claude config as the session's user settings and keeps it out of the --settings file", () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'skills', 'delegate'), { recursive: true });
  writeFileSync(join(ctx.dir, 'skills', 'delegate', 'SKILL.md'), 'delegate');
  writeFileSync(join(ctx.dir, 'statusline.sh'), 'echo status');

  writeFileSync(
    join(ctx.dir, 'settings.json'),
    JSON.stringify({
      outputStyle: 'STE Direct',
      model: 'opus[1m]',
      statusLine: { type: 'command', command: `bash "${ctx.dir}/statusline.sh"`, padding: 2 },
    }),
  );

  updateEnv('CLAUDE_CONFIG_DIR', ctx.dir);

  const config = parseConfig({
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

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const bundleDir = plan.args.at(6);

  if (bundleDir === undefined) {
    throw new Error('expected the staged bundle folder in the launch');
  }

  const bundleKey = bundleDir.replace('/tmp/atc/sessions/s1/', '');
  const userSettings = plan.files[`${bundleKey}/settings.json`];
  const flagSettings = plan.files['auth-r1/settings.json'];

  if (typeof userSettings !== 'string' || typeof flagSettings !== 'string') {
    throw new TypeError('expected the bundle and revision settings files');
  }

  expect(JSON.parse(userSettings)).toStrictEqual({
    model: 'opus[1m]',
    outputStyle: 'STE Direct',
    statusLine: {
      type: 'command',
      command: 'bash "/tmp/atc/sessions/s1/claude-config/statusline.sh"',
      padding: 2,
    },
    permissions: { defaultMode: 'auto' },
  });

  expect(JSON.parse(flagSettings)).toStrictEqual({
    hooks: expect.toContainAllKeys([
      'SessionStart',
      'Notification',
      'Stop',
      'UserPromptSubmit',
      'SessionEnd',
    ]),
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent \'claude\'',
      padding: 2,
    },
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  expect(Object.keys(plan.files)).toIncludeSameMembers([
    'auth-r1/settings.json',
    'claude-config-seed.json',
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
  using ctx = setupTest();

  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      linear: {
        secret: 'linear-imp-agents',
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

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const mcpConfig = plan.files['auth-r3/mcp.json'];

  if (typeof mcpConfig !== 'string') {
    throw new TypeError('expected the revision MCP config file');
  }

  expect(plan.args.slice(7)).toStrictEqual([
    'claude',
    '--mcp-config',
    '/tmp/atc/sessions/s1/auth-r3/mcp.json',
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
        headers: { authorization: 'Bearer imp-broker-placeholder' },
      },
    },
  });
});

test('it plans a guest spawn without a broker binding in the config of the host image', () => {
  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    files: expect.toContainAllKeys([
      'atc-bridge/.claude-plugin/plugin.json',
      'atc-bridge/hooks/hooks.json',
      'atc-bridge/hooks/register.ts',
      'atc-bridge/hooks/atc-cli.ts',
      'settings.json',
    ]),
  });
});

test.each([
  ['ANTHROPIC_API_KEY'],
  ['ANTHROPIC_AUTH_TOKEN'],
  ['ANTHROPIC_BASE_URL'],
  ['CLAUDE_CODE_USE_VERTEX'],
  ['HTTPS_PROXY'],
])('it refuses a subscription guest spawn whose configured --settings sets %s', (variable) => {
  const config = parseConfig({
    claudeArgs: ['--settings', JSON.stringify({ env: { [variable]: 'sk-test' } })],
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
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
  const adapter = new ClaudeAdapter(
    buildMockAgentEntry({
      id: 'claude',
      bin: 'claude',
      env: { ANTHROPIC_BASE_URL: 'https://x.example.com' },
      auth: { profiles: ['claude'], placeholderEnv: {} },
    }),
    parseConfig({}),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
          profileEnv: {},
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      message:
        "claude signs in through impd's broker on this target, but agents.claude.env sets ANTHROPIC_BASE_URL, which would override or route around that sign-in",
      data: { agent: 'claude', problem: 'guest_env_conflict', variable: 'ANTHROPIC_BASE_URL' },
    }),
  );
});

test('it refuses a subscription guest spawn whose entry settings env overrides the sign-in', () => {
  const adapter = new ClaudeAdapter(
    buildMockAgentEntry({
      id: 'claude',
      bin: 'claude',
      settings: { env: { HTTPS_PROXY: 'http://p.example:3128' } },
      auth: { profiles: ['claude'], placeholderEnv: {} },
    }),
    parseConfig({}),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
          profileEnv: {},
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      message:
        "claude signs in through impd's broker on this target, but agents.claude.settings.env sets HTTPS_PROXY, which would override or route around that sign-in",
      data: { agent: 'claude', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
    }),
  );
});

test('it refuses to start a subscription session in a host whose environment sets ANTHROPIC_API_KEY', () => {
  using ctx = setupTest();

  const config = parseConfig({
    claudeBin: 'true',
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: ctx.dir,
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const seed = plan.files['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected the seed file');
  }

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), seed);

  const run = Bun.spawnSync([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env, ANTHROPIC_API_KEY: 'sk-test' },
  });

  expect(run.exitCode).toBe(78);

  expect(run.stderr.toString()).toBe(
    "atc: ANTHROPIC_API_KEY is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start\n",
  );

  expect(existsSync(join(ctx.dir, 'claude-config'))).toBeFalse();
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
  (name, value) => {
    using ctx = setupTest();

    const config = parseConfig({
      claudeBin: 'true',
      authProfiles: {
        claude: {
          secret: 'claude-setup-token',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
      claudeAuth: { profiles: ['claude'] },
    });

    const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

    const plan = adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: ctx.dir,
        auth: {
          revision: 1,
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
          profileEnv: {},
        },
      },
    );

    if (plan === null) {
      throw new Error('expected a guest spawn plan');
    }

    const run = Bun.spawnSync([plan.bin, ...plan.args], {
      env: { PATH: process.env['PATH'] ?? '', ...plan.env, [name]: value },
    });

    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toStrictEqual({
      exitCode: 78,
      stderr: `atc: ${name} is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start\n`,
    });
  },
);

test('it starts a subscription session with a seeded config folder in a host whose environment sets no credential', () => {
  using ctx = setupTest();

  const config = parseConfig({
    claudeBin: 'true',
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: ctx.dir,
      auth: {
        revision: 1,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const seed = plan.files['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected the seed file');
  }

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), seed);

  const run = Bun.spawnSync([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env },
  });

  const seeded = readFileSync(join(ctx.dir, 'claude-config', '.claude.json'), 'utf8');

  expect(run.exitCode).toBe(0);
  expect(JSON.parse(seeded)).toStrictEqual({ hasCompletedOnboarding: true });
});

test("it seeds folder trust and approval of the clone's own MCP servers for the exact clone root of a subscription session", () => {
  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
    },
    claudeAuth: { profiles: ['claude'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const seed = adapter.planGuestWorkspaceTrust('/work/repo')?.['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected a seed file');
  }

  expect(JSON.parse(seed)).toStrictEqual({
    hasCompletedOnboarding: true,
    projects: { '/work/repo': { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });
});

test("it sets a profile's variables in a subscription guest's settings env and spawn env", () => {
  using ctx = setupTest();

  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      op: {
        secret: 'op-connect',
        host: 'op-connect.geoff.cloud',
        header: 'authorization',
        scheme: 'bearer',
        env: {
          OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
          OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        },
      },
    },
    claudeAuth: { profiles: ['claude', 'op'] },
  });

  const adapter = new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, {
    homeDir: join(ctx.dir, 'home'),
  });

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {
          OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
          OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        },
      },
    },
  );

  const settingsFile = plan?.files['auth-r2/settings.json'];

  if (plan === null || typeof settingsFile !== 'string') {
    throw new Error('expected a guest spawn plan with a settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect({ env: plan.env, settings }).toStrictEqual({
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
      OP_CONNECT_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
    },
    settings: {
      hooks: expect.toContainAllKeys([
        'SessionStart',
        'Notification',
        'Stop',
        'UserPromptSubmit',
        'SessionEnd',
      ]),
      statusLine: {
        type: 'command',
        command: '"/opt/atc/bin/atc" statusline --agent \'claude\'',
        padding: 0,
      },
      env: {
        OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
        OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  });
});

test("it leaves a profile's variables out of the local plan of an entry with a profile env", () => {
  using ctx = setupTest();

  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      op: {
        secret: 'op-connect',
        host: 'op-connect.geoff.cloud',
        header: 'authorization',
        scheme: 'bearer',
        env: {
          OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
          OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        },
      },
    },
    claudeAuth: { profiles: ['claude', 'op'] },
  });

  const adapter = new ClaudeAdapter(
    getAgentEntry(config, 'claude'),
    config,
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.dir, 'state', 'hook-settings-claude.json'), 'utf8'),
  );

  expect({ plan, settings }).toStrictEqual({
    settings: {
      hooks: expect.toContainAllKeys([
        'SessionStart',
        'Notification',
        'Stop',
        'UserPromptSubmit',
        'SessionEnd',
      ]),
      statusLine: {
        type: 'command',
        command: `"${process.execPath}" "${join(import.meta.dir, '..', 'cli.ts')}" statusline --agent 'claude'`,
        padding: 0,
      },
    },
    plan: {
      bin: 'claude',
      args: [
        '--settings',
        join(ctx.dir, 'state', 'hook-settings-claude.json'),
        '--plugin-dir',
        join(ctx.dir, 'atc-bridge'),
      ],
    },
  });
});
