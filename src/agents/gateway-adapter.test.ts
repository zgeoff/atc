import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { parseConfig } from '../shared/config';
import type { Config } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { GatewayAdapter } from './gateway-adapter';

function buildGatewayAdapter(): GatewayAdapter {
  const config: Config = {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    workspaces: { githubOwner: null, sources: null, gitTransports: ['https', 'ssh'] },
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    targetErrors: [],
    principals: null,
    principalErrors: [],
    workspaceErrors: [],
  };

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
    {
      claudeBin: 'claude',
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      dirs: { roots: [] },
      workspaces: { githubOwner: null, sources: null, gitTransports: ['https', 'ssh'] },
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
      targets: [{ id: 'local', provider: 'local-pty', options: {} }],
      defaultTarget: 'local',
      targetErrors: [],
      principals: null,
      principalErrors: [],
      workspaceErrors: [],
    },
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
    {
      claudeBin: 'claude',
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      dirs: { roots: [] },
      workspaces: { githubOwner: null, sources: null, gitTransports: ['https', 'ssh'] },
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
      targets: [{ id: 'local', provider: 'local-pty', options: {} }],
      defaultTarget: 'local',
      targetErrors: [],
      principals: null,
      principalErrors: [],
      workspaceErrors: [],
    },
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
