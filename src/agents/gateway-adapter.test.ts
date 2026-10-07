import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentEntry } from '../../test/get-agent-entry';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { ClaudeAdapter } from './claude-adapter';
import { GatewayAdapter } from './gateway-adapter';

function buildGatewayAdapter(): GatewayAdapter {
  const config = parseConfig({});

  return new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
    config,
  );
}

test('it answers to the id its backend was configured under', () => {
  expect(buildGatewayAdapter().id).toBe('zai');
});

test('it runs no headless turn when the daemon gave it no runner', () => {
  expect(buildGatewayAdapter().headlessRunner).toBeNull();
});

test('it reads a session id and transcript out of a Claude hook payload', () => {
  const adapter = buildGatewayAdapter();

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

test('it resumes only while the reported transcript is still on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-gateway-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = buildGatewayAdapter();

  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});

test('it takes inbox messages', () => {
  const adapter = buildGatewayAdapter();

  expect(adapter.takesMessages).toBe(true);
});

test("it runs a headless turn through the gateway's binary and settings file under the auto permission mode with the atc-bridge mod", () => {
  using tmp = setupTempDir('atc-gateway-bridge-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: '/opt/zai/bin/claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
    parseConfig({}),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(received).toStrictEqual({
    cwd: '/tmp',
    prompt: 'go',
    claudeBin: '/opt/zai/bin/claude',
    permissionMode: 'auto',
    pluginDir: join(tmp.dir, 'atc-bridge'),
    settings: expect.toEndWith('.json'),
  });
});

test('it profiles a gateway with only the model names its env sets', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: '/opt/claude/bin/claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'op read op://vault/zai/key',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
        ANTHROPIC_MODEL: 'glm-4.6',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret',
        API_TIMEOUT_MS: '600000',
      },
    },
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
  expect(buildGatewayAdapter().profile.models).toBeNull();
});

test("it runs a headless turn under the permission mode the gateway's settings default to", () => {
  using tmp = setupTempDir('atc-gateway-mode-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new GatewayAdapter(
    {
      id: 'manual-settings',
      label: 'Manual by settings',
      mark: 'm',
      bin: 'claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'default' } },
    },
    parseConfig({}),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(received).toMatchObject({ permissionMode: 'default' });
});

test("it gives a gateway's explicit permission-mode argument the same meaning in its terminal and headless runs", () => {
  using tmp = setupTempDir('atc-gateway-flag-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new GatewayAdapter(
    {
      id: 'manual-flag',
      label: 'Manual by flag',
      mark: 'm',
      bin: 'claude',
      args: ['--permission-mode', 'default'],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    },
    parseConfig({}),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(plan.args.slice(0, 2)).toStrictEqual(['--permission-mode', 'default']);
  expect(received).toMatchObject({ permissionMode: 'default' });
});

test("it keeps the gateway's arguments, its permission mode included, in the command that resumes it outside atc", () => {
  using tmp = setupTempDir('atc-gateway-resume-');

  const adapter = new GatewayAdapter(
    {
      id: 'manual-resume',
      label: 'Manual on resume',
      mark: 'm',
      bin: '/opt/gw/bin/claude',
      args: ['--permission-mode', 'default'],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
    },
    parseConfig({}),
    null,
    join(tmp.dir, 'atc-bridge'),
  );

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(command).toMatch(
    /^cd '\/work\/repo' && \/opt\/gw\/bin\/claude '--permission-mode' 'default' --settings '[^']+hook-settings-manual-resume\.json' --resume sess-1$/u,
  );
});

test("it runs a headless turn with the gateway's settings file, its permission hook and mode included", () => {
  using tmp = setupTempDir('atc-gateway-hook-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new GatewayAdapter(
    {
      id: 'manual-hook',
      label: 'Manual with hook',
      mark: 'm',
      bin: 'claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: {
        permissions: { defaultMode: 'default' },
        hooks: {
          PermissionRequest: [{ hooks: [{ type: 'command', command: 'decide-permission' }] }],
        },
      },
    },
    parseConfig({}),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  const settingsPath = received['settings'];

  if (typeof settingsPath !== 'string') {
    throw new TypeError('the headless turn carried no settings file');
  }

  const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));

  expect(received).toMatchObject({ permissionMode: 'default' });

  expect(settings).toMatchObject({
    permissions: { defaultMode: 'default' },
    hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'decide-permission' }] }],
    },
  });
});

test("it restores a session in the permission mode the gateway's settings default to", () => {
  using tmp = setupTempDir('atc-gateway-restore-');

  const adapter = new GatewayAdapter(
    {
      id: 'restore-settings',
      label: 'Restore by settings',
      mark: 'r',
      bin: 'claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'default' } },
    },
    parseConfig({}),
    null,
    join(tmp.dir, 'atc-bridge'),
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan.args).toIncludeAllMembers(['--permission-mode', 'default']);
  expect(plan.args.indexOf('--permission-mode') + 1).toBe(plan.args.indexOf('default'));
});

test("it keeps the gateway's settings default mode in the command that resumes it outside atc", () => {
  using tmp = setupTempDir('atc-gateway-resume-settings-');

  const adapter = new GatewayAdapter(
    {
      id: 'resume-settings',
      label: 'Resume by settings',
      mark: 'r',
      bin: '/opt/gw/bin/claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'default' } },
    },
    parseConfig({}),
    null,
    join(tmp.dir, 'atc-bridge'),
  );

  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(command).toMatch(
    /^cd '\/work\/repo' && \/opt\/gw\/bin\/claude '--permission-mode' 'default' --settings '[^']+hook-settings-resume-settings\.json' --resume sess-1$/u,
  );
});

test('it restores and resumes a gateway in its explicit permission-mode argument over its settings default', () => {
  using tmp = setupTempDir('atc-gateway-restore-flag-');

  const adapter = new GatewayAdapter(
    {
      id: 'restore-flag',
      label: 'Restore by flag',
      mark: 'r',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'default' } },
    },
    parseConfig({}),
    null,
    join(tmp.dir, 'atc-bridge'),
  );

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });
  const command = adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'));

  expect(plan.args.filter((arg) => arg === '--permission-mode')).toStrictEqual([
    '--permission-mode',
  ]);

  expect(plan.args).not.toContain('default');
  expect(command).toInclude("'--permission-mode' 'plan'");
  expect(command).not.toInclude("'default'");
});

test("it refuses to start a gateway with auth on the daemon's machine", () => {
  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    parseConfig({}),
  );

  expect(() => adapter.planSpawn({ prompt: '', resume: false })).toThrow(
    expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }),
  );
});

test('it gives a gateway with auth no headless runner and no resume command', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: { profiles: ['glm'], placeholderEnv: {} },
    },
    parseConfig({}),
    () => ({ stop: () => {} }),
  );

  expect({
    headless: adapter.headlessRunner,
    resume: adapter.buildResumeCommand('/work', toAgentSessionID('a1')),
  }).toStrictEqual({ headless: null, resume: null });
});

test('it plans a brokered guest spawn with its own settings file, Claude config folder and placeholder credential', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 3, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
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

  expect(settings).toContainAllKeys(['hooks', 'statusLine', 'env']);

  expect(settings).toHaveProperty('env', {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });

  expect(settings).toHaveProperty(
    'statusLine.command',
    '"/opt/atc/bin/atc" statusline --agent \'glm\'',
  );

  expect(onboarding).toStrictEqual({ hasCompletedOnboarding: true });

  expect(Object.keys(plan.files)).toIncludeAllMembers([
    'auth-r3/settings.json',
    'claude-config-seed.json',
    'atc-bridge/.claude-plugin/plugin.json',
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
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      settings: { permissions: { defaultMode: 'default' }, hooks: { PermissionRequest: [hook] } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
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

  expect(settings).toHaveProperty('permissions', { defaultMode: 'default' });
  expect(settings).toHaveProperty('hooks.PermissionRequest', [hook]);
});

test.each([
  { name: 'ANTHROPIC_API_KEY', env: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' } },
  { name: 'no variable', env: {} },
  {
    name: 'a second variable',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      ANTHROPIC_API_KEY: 'imp-broker-placeholder',
    },
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN beside the bearer variable',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
    },
  },
  { name: 'a value other than the placeholder', env: { ANTHROPIC_AUTH_TOKEN: 'sk-real' } },
])('it refuses a brokered guest spawn whose placeholders hold $name', (row) => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: { profiles: ['glm'], placeholderEnv: row.env },
    },
    config,
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1', auth: { revision: 1, env: row.env } },
    ),
  ).toThrow(
    expect.objectContaining({ code: 'auth_placeholder_unsupported', data: { agent: 'glm' } }),
  );
});

test('it carries an extra placeholder variable and the gateway args into a brokered guest launch', () => {
  const placeholderEnv = {
    ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
    TYPESAFE_API_KEY: 'imp-broker-placeholder',
  };

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: { profiles: ['glm', 'jev'], placeholderEnv },
    },
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

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: placeholderEnv },
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

  expect(plan.env).toMatchObject(placeholderEnv);
  expect(settings).toHaveProperty('env', expect.objectContaining(placeholderEnv));
  expect(plan.args).toContain('/opt/auto-mode/mods/auto-mode');
  expect(plan.args[plan.args.indexOf('/opt/auto-mode/mods/auto-mode') - 1]).toBe('--plugin-dir');
});

test("it refuses a brokered guest spawn whose profile sets a header other than a bearer authorization for the base URL's host", () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
      },
    ),
  ).toThrow(expect.objectContaining({ code: 'auth_placeholder_unsupported' }));
});

test('it refuses a brokered guest spawn on a host that gave it no broker binding', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
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
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'zai-key',
      env: {},
    },
    parseConfig({}),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  expect(plan).toBeNull();
});

test('it plans no brokered guest spawn on a host without atc', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    parseConfig({}),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: null,
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
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
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: `echo ${canary}`,
      env: {},
      settings: { apiKeyHelper: `echo ${canary}`, env: { ANTHROPIC_API_KEY: canary } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  expect(Object.keys(plan.files)).not.toBeEmpty();
  expect(JSON.stringify(plan)).not.toInclude(canary);
  expect(JSON.stringify(plan)).not.toInclude('apiKeyHelper');
});

test("it seeds a brokered guest's Claude config with the onboarding state when the folder holds none", () => {
  using tmp = setupTempDir('atc-gateway-seed-');

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'true',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: tmp.dir,
      auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const seed = plan.files['claude-config-seed.json'];

  if (typeof seed !== 'string') {
    throw new TypeError('expected the seed file');
  }

  writeFileSync(join(tmp.dir, 'claude-config-seed.json'), seed);

  const run = Bun.spawnSync([plan.bin, ...plan.args]);
  const seeded = readFileSync(join(tmp.dir, 'claude-config', '.claude.json'), 'utf8');

  expect(run.exitCode).toBe(0);
  expect(JSON.parse(seeded)).toStrictEqual({ hasCompletedOnboarding: true });
});

test("it keeps the state an earlier run left in a brokered guest's Claude config, an accepted folder trust included", () => {
  using tmp = setupTempDir('atc-gateway-seed-');

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'true',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      dir: tmp.dir,
      auth: { revision: 2, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
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

  writeFileSync(join(tmp.dir, 'claude-config-seed.json'), seed);
  mkdirSync(join(tmp.dir, 'claude-config'));
  writeFileSync(join(tmp.dir, 'claude-config', '.claude.json'), earlier);

  const run = Bun.spawnSync([plan.bin, ...plan.args]);

  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(tmp.dir, 'claude-config', '.claude.json'), 'utf8')).toBe(earlier);
});

test('it starts a brokered guest in the permission mode the plain Claude adapter passes for the same arguments', () => {
  const config = parseConfig({
    claudeArgs: ['--permission-mode', 'plan'],
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const claude = new ClaudeAdapter(getAgentEntry(config, 'claude'), config);

  const gateway = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    config,
  );

  const guest = {
    atc: '/opt/atc/bin/atc',
    dir: '/tmp/atc/sessions/s1',
    auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
  };

  const brokered = gateway.planGuestSpawn({ prompt: '', resume: false }, guest);

  const plain = claude.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: guest.atc, dir: guest.dir },
  );

  if (brokered === null || plain === null) {
    throw new Error('expected both guest spawn plans');
  }

  const brokeredMode = brokered.args.filter((arg) => arg === '--permission-mode' || arg === 'plan');
  const plainMode = plain.args.filter((arg) => arg === '--permission-mode' || arg === 'plan');

  expect(brokeredMode).toStrictEqual(['--permission-mode', 'plan']);
  expect(brokeredMode).toStrictEqual(plainMode);
});

test.each([
  { name: 'a fresh spawn', resume: false },
  { name: 'a resume', resume: toAgentSessionID('a1') },
])(
  "it starts $name of a brokered guest in Claude's manual mode when the gateway sets none",
  (row) => {
    const config = parseConfig({
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    });

    const adapter = new GatewayAdapter(
      {
        id: 'glm',
        label: 'glm',
        mark: 'g',
        bin: 'claude',
        args: [],
        baseURL: 'https://api.z.ai/api/anthropic',
        env: {},
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
      config,
    );

    const plan = adapter.planGuestSpawn(
      { prompt: '', resume: row.resume },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' } },
      },
    );

    if (plan === null) {
      throw new Error('expected a guest spawn plan');
    }

    const mode = plan.args.indexOf('--permission-mode');

    expect(plan.args.slice(mode, mode + 2)).toStrictEqual(['--permission-mode', 'default']);
    expect(plan.args.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
  },
);

test('it selects the credential a gateway with auth takes from the broker, with the auth profiles it resolves against', () => {
  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
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
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
    parseConfig({}),
  );

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it refuses no start of a gateway with auth whose placeholder pairs with the bearer header', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
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
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
      },
    },
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
    {
      id: 'glm',
      label: 'glm',
      mark: 'g',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
      settings: { env: { https_proxy: 'http://proxy.example:3128' } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
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
  expect(
    buildGatewayAdapter().planLineInput('a'.repeat(1600), { bracketedPaste: true }),
  ).toStrictEqual([`\u001B[200~${'a'.repeat(1600)}\u001B[201~`, '\r']);
});
