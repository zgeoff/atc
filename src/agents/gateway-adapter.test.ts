import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMockGatewayConfig } from '../test-utils/build-mock-gateway-config';
import { buildStubHeadlessRunner } from '../test-utils/build-stub-headless-runner';
import { KEYS } from '../test-utils/keys';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { GatewayAdapter } from './gateway-adapter';

// A folder for the files a test writes: transcripts, the atc-bridge mod, or a
// guest folder a launch runs in.
function setupTest() {
  return setupTempDir('atc-gateway-adapter-');
}

test('it answers to the id its backend was configured under', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig({ id: 'zai' }), parseConfig({}));

  expect(adapter.id).toBe('zai');
});

test('it runs no headless turn when the daemon gave it no runner', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(adapter.headlessRunner).toBeNull();
});

test('it reads a session id and transcript out of a Claude hook payload', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(
    adapter.normalizeHook({
      atcId: toSessionID('s1'),
      event: 'SessionStart',
      payload: { session_id: 'z-1', transcript_path: '/tmp/t.jsonl' },
    }),
  ).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('z-1'),
    nameSource: '/tmp/t.jsonl',
    transcriptSource: '/tmp/t.jsonl',
  });
});

test('it resumes while the reported transcript is still on disk', () => {
  using ctx = setupTest();

  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(adapter.canResume({ transcriptSource: transcript })).toBeTrue();
});

test('it does not resume once the reported transcript is gone', () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(adapter.canResume({ transcriptSource: join(ctx.dir, 'missing.jsonl') })).toBeFalse();
});

test('it takes inbox messages', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(adapter.takesMessages).toBeTrue();
});

test("it runs a headless turn through the gateway's binary and settings file under the auto permission mode with the atc-bridge mod", () => {
  using ctx = setupTest();

  const runner = buildStubHeadlessRunner();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({ id: 'zai', bin: '/opt/zai/bin/claude' }),
    parseConfig({}),
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
      claudeBin: '/opt/zai/bin/claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-zai.json'),
    },
    expect.anything(),
  );
});

test('it profiles a gateway with only the model names its env sets', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      label: 'GLM (z.ai)',
      bin: '/opt/claude/bin/claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'op read op://vault/zai/key',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
        ANTHROPIC_MODEL: 'glm-4.6',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret',
        API_TIMEOUT_MS: '600000',
      },
    }),
    parseConfig({}),
  );

  expect(adapter.profile).toStrictEqual({
    label: 'GLM (z.ai)',
    kind: 'gateway',
    bin: '/opt/claude/bin/claude',
    models: { opus: 'glm-4.6', haiku: 'glm-4.5-air', default: 'glm-4.6' },
    spawnOptions: {
      model: {
        supported: true,
        values: null,
        examples: [
          { value: 'opus', resolvesTo: 'glm-4.6' },
          { value: 'haiku', resolvesTo: 'glm-4.5-air' },
        ],
        default: 'glm-4.6',
        backendEffect: 'applied',
        note: "A tier alias the gateway's env maps, or a model name the provider accepts, passed as --model.",
      },
      effort: {
        supported: true,
        values: ['low', 'medium', 'high', 'xhigh', 'max'],
        examples: [],
        default: null,
        backendEffect: 'unverified',
        note: "Passed as --effort; the gateway's provider may ignore it.",
      },
    },
  });
});

test('it profiles a gateway whose env sets no model with no models', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig({ env: {} }), parseConfig({}));

  expect(adapter.profile.models).toBeNull();
});

test("it runs a headless turn under the permission mode the gateway's settings default to", () => {
  using ctx = setupTest();

  const runner = buildStubHeadlessRunner();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-settings',
      bin: 'claude',
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig({}),
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
      permissionMode: 'default',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-manual-settings.json'),
    },
    expect.anything(),
  );
});

test("it runs a headless turn under a gateway's explicit permission-mode argument over its settings default", () => {
  using ctx = setupTest();

  const runner = buildStubHeadlessRunner();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-flag',
      bin: 'claude',
      args: ['--permission-mode', 'default'],
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    }),
    parseConfig({}),
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
      permissionMode: 'default',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-manual-flag.json'),
    },
    expect.anything(),
  );
});

test("it starts a gateway's terminal run under its explicit permission-mode argument over its settings default", () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-flag',
      bin: 'claude',
      args: ['--permission-mode', 'default'],
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'default',
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-manual-flag.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
    ],
  });
});

test("it keeps the gateway's arguments, its permission mode included, in the command that resumes it outside atc", () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-resume',
      bin: '/opt/gw/bin/claude',
      args: ['--permission-mode', 'default'],
      baseURL: 'https://gateway.example/anthropic',
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(command).toBe(
    `cd '/work/repo' && /opt/gw/bin/claude '--permission-mode' 'default' --settings '${join(ctx.dir, 'state', 'hook-settings-manual-resume.json')}' --resume sess-1`,
  );
});

test("it runs a headless turn with the gateway's settings file, its permission hook and mode included", () => {
  using ctx = setupTest();

  const runner = buildStubHeadlessRunner();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-hook',
      bin: 'claude',
      baseURL: 'https://gateway.example/anthropic',
      settings: {
        permissions: { defaultMode: 'default' },
        hooks: {
          PermissionRequest: [{ hooks: [{ type: 'command', command: 'decide-permission' }] }],
        },
      },
    }),
    parseConfig({}),
    runner,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.dir, 'state', 'hook-settings-manual-hook.json'), 'utf8'),
  );

  expect({ request: runner.mock.calls[0]?.[0], settings }).toStrictEqual({
    request: {
      cwd: '/tmp',
      prompt: 'go',
      claudeBin: 'claude',
      permissionMode: 'default',
      pluginDir: join(ctx.dir, 'atc-bridge'),
      settings: join(ctx.dir, 'state', 'hook-settings-manual-hook.json'),
    },
    settings: {
      permissions: { defaultMode: 'default' },
      hooks: {
        SessionStart: expect.toBeArray(),
        Notification: expect.toBeArray(),
        Stop: expect.toBeArray(),
        UserPromptSubmit: expect.toBeArray(),
        SessionEnd: expect.toBeArray(),
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'decide-permission' }] }],
      },
      statusLine: {
        type: 'command',
        command: `"${process.execPath}" "${join(import.meta.dir, '..', 'cli.ts')}" statusline --agent 'manual-hook'`,
        padding: 0,
      },
      env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' },
    },
  });
});

test("it restores a session in the permission mode the gateway's settings default to", () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-settings',
      bin: 'claude',
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'default',
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-restore-settings.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test("it keeps the gateway's settings default mode in the command that resumes it outside atc", () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'resume-settings',
      bin: '/opt/gw/bin/claude',
      baseURL: 'https://gateway.example/anthropic',
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(command).toBe(
    `cd '/work/repo' && /opt/gw/bin/claude '--permission-mode' 'default' --settings '${join(ctx.dir, 'state', 'hook-settings-resume-settings.json')}' --resume sess-1`,
  );
});

test('it restores a gateway in its explicit permission-mode argument over its settings default', () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-flag',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'plan',
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-restore-flag.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it resumes a gateway outside atc in its explicit permission-mode argument over its settings default', () => {
  using ctx = setupTest();

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-flag',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig({}),
    null,
    join(ctx.dir, 'atc-bridge'),
    { stateDir: join(ctx.dir, 'state'), homeDir: join(ctx.dir, 'home') },
  );

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(command).toBe(
    `cd '/work/repo' && claude '--permission-mode' 'plan' --settings '${join(ctx.dir, 'state', 'hook-settings-restore-flag.json')}' --resume sess-1`,
  );
});

test("it refuses to start a gateway with auth on the daemon's machine", () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({}),
  );

  expect(() => adapter.planSpawn({ prompt: '', resume: false })).toThrow(
    expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }),
  );
});

test('it gives a gateway with auth no headless runner', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({ id: 'glm', auth: { profiles: ['glm'], placeholderEnv: {} } }),
    parseConfig({}),
    buildStubHeadlessRunner(),
  );

  expect(adapter.headlessRunner).toBeNull();
});

test('it gives a gateway with auth no resume command', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({ id: 'glm', auth: { profiles: ['glm'], placeholderEnv: {} } }),
    parseConfig({}),
    buildStubHeadlessRunner(),
  );

  expect(adapter.buildResumeCommand('/work', toAgentSessionID('a1'))).toBeNull();
});

test('it plans a brokered guest spawn with its own settings file, Claude config folder and placeholder credential', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const settingsFile = plan.files['auth-r3/settings.json'];

  if (typeof settingsFile !== 'string') {
    throw new TypeError('expected the revision settings file');
  }

  const onboardingFile = plan.files['claude-config-seed.json'];

  if (typeof onboardingFile !== 'string') {
    throw new TypeError('expected the Claude config file');
  }

  const settings: unknown = JSON.parse(settingsFile);
  const onboarding: unknown = JSON.parse(onboardingFile);

  expect({ bin: plan.bin, args: plan.args.slice(2), env: plan.env }).toStrictEqual({
    bin: 'sh',
    args: [
      'sh',
      '/tmp/atc/sessions/s1/claude-config',
      '/tmp/atc/sessions/s1/claude-config-seed.json',
      '/tmp/atc/sessions/s1/claude-config-bundle',
      '/tmp/atc/sessions/s1/claude-config-bundle/none',
      'claude',
      '--permission-mode',
      'default',
      '--settings',
      '/tmp/atc/sessions/s1/auth-r3/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
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
      command: '"/opt/atc/bin/atc" statusline --agent \'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  expect(onboarding).toStrictEqual({ hasCompletedOnboarding: true });

  expect(Object.keys(plan.files)).toIncludeSameMembers([
    'auth-r3/settings.json',
    'claude-config-seed.json',
    'atc-bridge/.claude-plugin/plugin.json',
    'atc-bridge/hooks/hooks.json',
    'atc-bridge/hooks/register.ts',
    'atc-bridge/hooks/atc-cli.ts',
  ]);
});

test("it keeps the gateway's permission hook and mode in a brokered guest's settings and restore arguments", () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const hook = { matcher: '.*', hooks: [{ type: 'command', command: 'classify', timeout: 90 }] };

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      settings: { permissions: { defaultMode: 'default' }, hooks: { PermissionRequest: [hook] } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const settingsFile = plan.files['auth-r1/settings.json'];

  if (typeof settingsFile !== 'string') {
    throw new TypeError('expected the revision settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect(plan.args.slice(8)).toStrictEqual([
    '--permission-mode',
    'default',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
    '--resume',
    'a1',
  ]);

  expect(settings).toStrictEqual({
    permissions: { defaultMode: 'default' },
    hooks: {
      SessionStart: expect.toBeArray(),
      Notification: expect.toBeArray(),
      Stop: expect.toBeArray(),
      UserPromptSubmit: expect.toBeArray(),
      SessionEnd: expect.toBeArray(),
      PermissionRequest: [hook],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent \'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test.each([
  [{ ANTHROPIC_API_KEY: 'imp-broker-placeholder' }],
  [{}],
  [{ ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder', ANTHROPIC_API_KEY: 'imp-broker-placeholder' }],
  [
    {
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
    },
  ],
  [{ ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder', CLAUDE_CONFIG_DIR: 'imp-broker-placeholder' }],
  [{ ANTHROPIC_AUTH_TOKEN: 'sk-real' }],
])('it refuses a brokered guest spawn whose placeholders are %p', (placeholderEnv) => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: placeholderEnv, profileEnv: {} },
      },
    ),
  ).toThrow(
    expect.objectContaining({ code: 'auth_placeholder_unsupported', data: { agent: 'glm' } }),
  );
});

test('it refuses no start of a gateway with auth that sets an extra placeholder variable', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'jev'],
        placeholderEnv: {
          ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
          TYPESAFE_API_KEY: 'imp-broker-placeholder',
        },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        jev: {
          secret: 'jev-imp-agents',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
    }),
  );

  expect(adapter.findSpawnRefusal()).toBeNull();
});

test('it carries an extra placeholder variable and the gateway args into a brokered guest launch', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'jev'],
        placeholderEnv: {
          ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
          TYPESAFE_API_KEY: 'imp-broker-placeholder',
        },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        jev: {
          secret: 'jev-imp-agents',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {
          ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
          TYPESAFE_API_KEY: 'imp-broker-placeholder',
        },
        profileEnv: {},
      },
    },
  );

  const settingsFile = plan?.files['auth-r1/settings.json'];

  if (plan === null || typeof settingsFile !== 'string') {
    throw new Error('expected a guest spawn plan with a settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect({ args: plan.args.slice(2), env: plan.env, settings }).toStrictEqual({
    args: [
      'sh',
      '/tmp/atc/sessions/s1/claude-config',
      '/tmp/atc/sessions/s1/claude-config-seed.json',
      '/tmp/atc/sessions/s1/claude-config-bundle',
      '/tmp/atc/sessions/s1/claude-config-bundle/none',
      'claude',
      '--plugin-dir',
      '/opt/auto-mode/mods/auto-mode',
      '--permission-mode',
      'default',
      '--settings',
      '/tmp/atc/sessions/s1/auth-r1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      TYPESAFE_API_KEY: 'imp-broker-placeholder',
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
        command: '"/opt/atc/bin/atc" statusline --agent \'glm\'',
        padding: 0,
      },
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
        TYPESAFE_API_KEY: 'imp-broker-placeholder',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  });
});

test("it refuses a brokered guest spawn whose profile sets a header other than a bearer authorization for the base URL's host", () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
          profileEnv: {},
        },
      },
    ),
  ).toThrow(
    expect.objectContaining({ code: 'auth_placeholder_unsupported', data: { agent: 'glm' } }),
  );
});

test('it refuses a brokered guest spawn on a host that gave it no broker binding', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({}),
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1' },
    ),
  ).toThrow(expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }));
});

test('it plans no guest spawn for a gateway whose credential helper runs on the daemon machine', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'zai-key',
    }),
    parseConfig({}),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan).toBeNull();
});

test('it plans no brokered guest spawn on a host without atc', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({}),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: null,
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan).toBeNull();
});

test('it keeps a credential held on the daemon side out of every file, argument and variable a brokered guest spawn plans', () => {
  const canary = 'canary-sk-7f3e9b21d4c8a6';

  updateEnv('ANTHROPIC_API_KEY', canary);
  updateEnv('ANTHROPIC_AUTH_TOKEN', canary);
  updateEnv('CLAUDE_CODE_OAUTH_TOKEN', canary);

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: `echo ${canary}`,
      settings: { apiKeyHelper: `echo ${canary}`, env: { ANTHROPIC_API_KEY: canary } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  expect(JSON.stringify(plan)).not.toMatch(/canary-sk-7f3e9b21d4c8a6|apiKeyHelper/u);
});

test("it seeds a brokered guest's Claude config with the onboarding state when the folder holds none", () => {
  using ctx = setupTest();

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'true',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: ctx.dir,
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
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

  const run = Bun.spawnSync([plan.bin, ...plan.args]);
  const seeded = readFileSync(join(ctx.dir, 'claude-config', '.claude.json'), 'utf8');

  expect(run.exitCode).toBe(0);
  expect(JSON.parse(seeded)).toStrictEqual({ hasCompletedOnboarding: true });
});

test("it keeps the state an earlier run left in a brokered guest's Claude config, an accepted folder trust included", () => {
  using ctx = setupTest();

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'true',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      dir: ctx.dir,
      auth: {
        revision: 2,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const earlier = JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { '/work': { hasTrustDialogAccepted: true } },
  });

  const seed = plan.files['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected the seed file');
  }

  writeFileSync(join(ctx.dir, 'claude-config-seed.json'), seed);
  mkdirSync(join(ctx.dir, 'claude-config'));
  writeFileSync(join(ctx.dir, 'claude-config', '.claude.json'), earlier);

  const run = Bun.spawnSync([plan.bin, ...plan.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'claude-config', '.claude.json'), 'utf8')).toBe(earlier);
});

test('it starts a brokered guest in the permission mode its configured arguments set', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args.slice(2)).toStrictEqual([
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    'claude',
    '--permission-mode',
    'plan',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);
});

test("it starts a fresh spawn of a brokered guest in Claude's manual mode when the gateway sets none", () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args.slice(2)).toStrictEqual([
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    'claude',
    '--permission-mode',
    'default',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);
});

test("it starts a resume of a brokered guest in Claude's manual mode when the gateway sets none", () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args.slice(2)).toStrictEqual([
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    'claude',
    '--permission-mode',
    'default',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
    '--resume',
    'a1',
  ]);
});

test('it selects the credential a gateway with auth takes from the broker, with the auth profiles it resolves against', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    config,
  );

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    profiles: config.authProfiles,
    brokerRequired: true,
  });
});

test('it selects no broker credential for a gateway without auth', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
    }),
    parseConfig({}),
  );

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it refuses no start of a gateway with auth whose placeholder pairs with the bearer header', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  expect(adapter.findSpawnRefusal()).toBeNull();
});

test('it refuses every start of a gateway with auth whose placeholder is not the bearer variable', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  expect(adapter.findSpawnRefusal()).toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'glm' },
  });
});

test('it refuses every start of a gateway with auth whose env sets a proxy variable', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      settings: { env: { https_proxy: 'http://proxy.example:3128' } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
  );

  expect(adapter.findSpawnRefusal()).toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', problem: 'guest_env_conflict', variable: 'https_proxy' },
  });
});

test('it pastes a long line and submits it with a carriage return as a second write', () => {
  const adapter = new GatewayAdapter(buildMockGatewayConfig(), parseConfig({}));

  expect(adapter.planLineInput('a'.repeat(1600), { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}${'a'.repeat(1600)}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test("it sets a profile's variables in a brokered guest's settings env and spawn env", () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'op'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        profileEnv: {
          OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
          OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        },
      },
    },
  );

  const settingsFile = plan?.files['auth-r3/settings.json'];

  if (plan === null || typeof settingsFile !== 'string') {
    throw new Error('expected a guest spawn plan with a settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect({ env: plan.env, settings }).toStrictEqual({
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
      OP_CONNECT_TOKEN: 'imp-broker-placeholder',
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
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
        command: '"/opt/atc/bin/atc" statusline --agent \'glm\'',
        padding: 0,
      },
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        OP_CONNECT_HOST: 'https://op-connect.geoff.cloud',
        OP_CONNECT_TOKEN: 'imp-broker-placeholder',
        ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  });
});

test('it refuses a local plan of a gateway whose profile sets variables', () => {
  const adapter = new GatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'op'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    }),
    parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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
    }),
  );

  expect(() => adapter.planSpawn({ prompt: '', resume: false })).toThrow(
    expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }),
  );
});
