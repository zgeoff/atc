import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { parseConfig } from '../shared/config';
import type { Config } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { ClaudeAdapter } from './claude-adapter';

function buildClaudeConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    claudeAuth: null,
    claudeAuthErrors: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    gateways: [],
    gatewayErrors: [],
    authProfiles: new Map(),
    authProfileErrors: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
  };
}

test('it resumes when no transcript was reported or the reported file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-claude-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 42, transcript_path: null, last_assistant_message: ['pong'] },
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
  });

  expect(ev).toMatchObject({ kind: 'turn-done', result: 'x'.repeat(700) });
  expect(ev.detail).toHaveLength(600);
});

test('it takes inbox messages', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.takesMessages).toBe(true);
});

test('it runs a headless turn through the configured claude binary under the auto permission mode with the atc-bridge mod', () => {
  using tmp = setupTempDir('atc-claude-bridge-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new ClaudeAdapter(
    buildClaudeConfig(),
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go', model: 'opus', effort: 'high' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(received).toStrictEqual({
    cwd: '/tmp',
    prompt: 'go',
    model: 'opus',
    effort: 'high',
    claudeBin: 'claude',
    permissionMode: 'auto',
    pluginDir: join(tmp.dir, 'atc-bridge'),
  });
});

test('it advertises the documented model aliases and effort levels with the configured defaults', () => {
  const adapter = new ClaudeAdapter({
    ...buildClaudeConfig(),
    claudeArgs: ['--model', 'opus', '--effort=high'],
  });

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
  const options = new ClaudeAdapter(buildClaudeConfig()).profile.spawnOptions;

  expect([options.model.default, options.effort.default]).toStrictEqual([null, null]);
});

test('it runs a headless turn under the permission mode its configured arguments set', () => {
  using tmp = setupTempDir('atc-claude-mode-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new ClaudeAdapter(
    parseConfig({ claudeArgs: ['--permission-mode', 'plan'] }),
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

  expect(received).toMatchObject({ permissionMode: 'plan' });
});

test('it keeps the permission mode its configured arguments set in the command that resumes it outside atc', () => {
  const adapter = new ClaudeAdapter(parseConfig({ claudeArgs: ['--permission-mode', 'plan'] }));

  expect(adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'))).toBe(
    "cd '/work/repo' && claude --permission-mode 'plan' --resume sess-1",
  );
});

test('it restores a stock session without a permission-mode argument', () => {
  using tmp = setupTempDir('atc-claude-stock-restore-');

  const adapter = new ClaudeAdapter(parseConfig({}), null, join(tmp.dir, 'atc-bridge'));

  const plan = adapter.planSpawn({ prompt: '', resume: toAgentSessionID('sess-1') });

  expect(plan.args).not.toContain('--permission-mode');

  expect(adapter.buildResumeCommand('/work/repo', toAgentSessionID('sess-1'))).toBe(
    "cd '/work/repo' && claude --resume sess-1",
  );
});

test('it pastes a long line and submits it with a carriage return as a second write', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.planLineInput('a'.repeat(1600), { bracketedPaste: true })).toStrictEqual([
    `\u001B[200~${'a'.repeat(1600)}\u001B[201~`,
    '\r',
  ]);
});

test('it takes no credential from the broker when the config holds no claudeAuth', () => {
  const adapter = new ClaudeAdapter(parseConfig({}));

  expect(adapter.findAuthSelection()).toBeNull();
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

  const adapter = new ClaudeAdapter(config);

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
  const adapter = new ClaudeAdapter(
    parseConfig({
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
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 2, env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  const settingsFile = plan.files['auth-r2/settings.json'];

  if (settingsFile === undefined) {
    throw new Error('expected the revision settings file');
  }

  const settings: unknown = JSON.parse(settingsFile);

  expect({ bin: plan.bin, args: plan.args.slice(2), env: plan.env }).toStrictEqual({
    bin: 'sh',
    args: [
      'sh',
      '/tmp/atc/sessions/s1/claude-config',
      '/tmp/atc/sessions/s1/claude-config-seed.json',
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

  expect(settings).toHaveProperty('env', {
    CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });

  const seed = plan.files['claude-config-seed.json'];

  if (seed === undefined) {
    throw new Error('expected a seed file');
  }

  expect(JSON.parse(seed)).toStrictEqual({ hasCompletedOnboarding: true });
});

test('it plans a guest spawn without a broker binding in the config of the host image', () => {
  const adapter = new ClaudeAdapter(
    parseConfig({
      authProfiles: {
        claude: {
          secret: 'claude-setup-token',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
      claudeAuth: { profiles: ['claude'] },
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    { atc: '/opt/atc/bin/atc', dir: '/tmp/atc/sessions/s1' },
  );

  expect(plan).toMatchObject({
    bin: 'claude',
    args: [
      '--settings',
      '/tmp/atc/sessions/s1/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
  });

  expect(plan).not.toContainKey('env');
});

test.each([
  ['ANTHROPIC_API_KEY'],
  ['ANTHROPIC_AUTH_TOKEN'],
  ['ANTHROPIC_BASE_URL'],
  ['CLAUDE_CODE_USE_VERTEX'],
  ['HTTPS_PROXY'],
])('it refuses a subscription guest spawn whose configured --settings sets %s', (variable) => {
  const adapter = new ClaudeAdapter(
    parseConfig({
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
    }),
  );

  const plan = () =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' } },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      data: { agent: 'claude', problem: 'guest_env_conflict', variable },
    }),
  );
});

test('it refuses to start a subscription session in a host whose environment sets ANTHROPIC_API_KEY', () => {
  using tmp = setupTempDir('atc-claude-refuse-');

  const adapter = new ClaudeAdapter(
    parseConfig({
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
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: tmp.dir,
      auth: { revision: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  writeFileSync(
    join(tmp.dir, 'claude-config-seed.json'),
    plan.files['claude-config-seed.json'] ?? '',
  );

  const run = Bun.spawnSync([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env, ANTHROPIC_API_KEY: 'sk-test' },
  });

  expect(run.exitCode).toBe(78);

  expect(run.stderr.toString()).toBe(
    "atc: ANTHROPIC_API_KEY is set in this host's environment and overrides the sign-in atc gives this session, so Claude does not start\n",
  );

  expect(existsSync(join(tmp.dir, 'claude-config'))).toBeFalse();
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
    using tmp = setupTempDir('atc-claude-route-');

    const adapter = new ClaudeAdapter(
      parseConfig({
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
      }),
    );

    const plan = adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        dir: tmp.dir,
        auth: { revision: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' } },
      },
    );

    if (plan === null) {
      throw new Error('expected a guest spawn plan');
    }

    const run = Bun.spawnSync([plan.bin, ...plan.args], {
      env: { PATH: process.env['PATH'] ?? '', ...plan.env, [name]: value },
    });

    expect(run.exitCode).toBe(78);
    expect(run.stderr.toString()).toStartWith(`atc: ${name} is set in this host's environment`);
  },
);

test('it starts a subscription session with a seeded config folder in a host whose environment sets no credential', () => {
  using tmp = setupTempDir('atc-claude-seed-');

  const adapter = new ClaudeAdapter(
    parseConfig({
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
    }),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      dir: tmp.dir,
      auth: { revision: 1, env: { CLAUDE_CODE_OAUTH_TOKEN: 'imp-broker-placeholder' } },
    },
  );

  if (plan === null) {
    throw new Error('expected a guest spawn plan');
  }

  writeFileSync(
    join(tmp.dir, 'claude-config-seed.json'),
    plan.files['claude-config-seed.json'] ?? '',
  );

  const run = Bun.spawnSync([plan.bin, ...plan.args], {
    env: { PATH: process.env['PATH'] ?? '', ...plan.env },
  });

  const seeded = readFileSync(join(tmp.dir, 'claude-config', '.claude.json'), 'utf8');

  expect(run.exitCode).toBe(0);
  expect(JSON.parse(seeded)).toStrictEqual({ hasCompletedOnboarding: true });
});

test('it seeds folder trust for the exact clone root of a subscription session', () => {
  const adapter = new ClaudeAdapter(
    parseConfig({
      authProfiles: {
        claude: {
          secret: 'claude-setup-token',
          host: 'api.anthropic.com',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
      claudeAuth: { profiles: ['claude'] },
    }),
  );

  const seed = adapter.planGuestWorkspaceTrust('/work/repo')?.['claude-config-seed.json'];

  if (seed === undefined) {
    throw new Error('expected a seed file');
  }

  expect(JSON.parse(seed)).toStrictEqual({
    hasCompletedOnboarding: true,
    projects: { '/work/repo': { hasTrustDialogAccepted: true } },
  });
});
