import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseConfig } from '@atc/config';
import { getAgentEntry } from '@atc/config/test-utils/get-agent-entry';
import { isRecord } from '@atc/core';
import { KEYS } from '@atc/core/test-utils/keys';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { updateEnv } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { ATC_BRIDGE_FILES } from '../bridge/atc-bridge-files';
import { CLAUDE_PLUGIN } from '../plugin/claude-plugin';
import { buildMockGatewayConfig } from '../test-utils/build-mock-gateway-config';
import { buildStubClaudeHeadlessRun } from '../test-utils/build-stub-claude-headless-run';
import { createGatewayAdapter } from './create-gateway-adapter';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-gateway-adapter-');

  return { directory: temporaryDirectory.path };
}

test('it answers to the id its backend was configured under', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ id: 'zai' }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.id).toBe('zai');
});

test('it runs no headless turn when the daemon gave it no runner', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.headlessRunner).toBeNull();
});

test("it reads a session's hook lines as Claude's, with no state across them", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = adapter.planHookEvents({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { session_id: 'z-1', transcript_path: '/tmp/t.jsonl' },
  });

  expect(plan).toStrictEqual({
    events: [
      {
        kind: 'started',
        agentSessionID: toAgentSessionID('z-1'),
        nameSource: '/tmp/t.jsonl',
        transcriptSource: '/tmp/t.jsonl',
      },
    ],
  });
});

test('it takes inbox messages', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.takesMessages).toBeTrue();
});

test('it plans the guest bridge files a running remote session gets written again', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.planGuestBridgeFiles('/opt/atc/bin/atc', 1_793_000_000_000)).toStrictEqual({
    'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
    'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
    'atc-bridge/hooks/bridge-state.ts': ATC_BRIDGE_FILES['hooks/bridge-state.ts'],
    'atc-bridge/hooks/encode-attribute.ts': ATC_BRIDGE_FILES['hooks/encode-attribute.ts'],
    'atc-bridge/hooks/parse-tap-line.ts': ATC_BRIDGE_FILES['hooks/parse-tap-line.ts'],
    'atc-bridge/hooks/run-tap.ts': ATC_BRIDGE_FILES['hooks/run-tap.ts'],
    'atc-bridge/hooks/schedule-answered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-answered-report.ts'],
    'atc-bridge/hooks/schedule-delivery.ts': ATC_BRIDGE_FILES['hooks/schedule-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-delivery.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-reminder.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-reminder.ts'],
    'atc-bridge/hooks/schedule-unanswered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-unanswered-report.ts'],
    'atc-bridge/hooks/try-update-conversation.ts':
      ATC_BRIDGE_FILES['hooks/try-update-conversation.ts'],
    'atc-bridge/hooks/update-turn-completed.ts': ATC_BRIDGE_FILES['hooks/update-turn-completed.ts'],
    'atc-bridge/hooks/update-turn-started.ts': ATC_BRIDGE_FILES['hooks/update-turn-started.ts'],
    'atc-bridge/hooks/wait-for-step-end.ts': ATC_BRIDGE_FILES['hooks/wait-for-step-end.ts'],
    'atc-bridge/hooks/atc-cli.ts':
      'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n' +
      '// written again at 1793000000000: Claude Code loads a mod again only when a file of it changes\n',
  });
});

test("it runs a headless turn through the gateway's binary and settings file under the auto permission mode with the atc-bridge mod", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ id: 'zai', bin: '/opt/zai/bin/claude' }),
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
    { cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: '/opt/zai/bin/claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-zai.json'),
    },
    events,
  );
});

test('it profiles a gateway with only the model names its env sets', () => {
  const adapter = createGatewayAdapter(
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
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
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
      pluginDirs: {
        supported: true,
        values: null,
        examples: [],
        default: null,
        backendEffect: 'applied',
        note: "Each folder passed as --plugin-dir, after the folders the agent's config sets. An absolute path or one that starts with ~/ on the daemon's machine, without a .. segment; a path that does not exist or is not a folder, or a remote target, refuses the spawn.",
      },
    },
  });
});

test('it profiles a gateway whose env sets no model with no models', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ env: {} }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.profile.models).toBeNull();
});

test("it runs a headless turn under the permission mode the gateway's settings default to", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-settings',
      bin: 'claude',
      settings: { permissions: { defaultMode: 'default' } },
    }),
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
    { cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: 'claude',
      permissionMode: 'default',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-manual-settings.json'),
    },
    events,
  );
});

test("it runs a headless turn under a gateway's explicit permission-mode argument over its settings default", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-flag',
      bin: 'claude',
      args: ['--permission-mode', 'default'],
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    }),
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
    { cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: 'claude',
      permissionMode: 'default',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-manual-flag.json'),
    },
    events,
  );
});

test("it starts a gateway's terminal run under its explicit permission-mode argument over its settings default", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-flag',
      bin: 'claude',
      args: ['--permission-mode', 'default'],
      settings: { permissions: { defaultMode: 'acceptEdits' } },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--permission-mode',
      'default',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-manual-flag.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
    ],
  });
});

test("it loads a gateway's configured plugin folders with ~ expanded, then the session's own, after atc's mod", () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    agents: {
      zai: {
        kind: 'claude',
        baseURL: 'https://api.z.ai/api/anthropic',
        pluginDirs: ['~/plugins/band'],
      },
    },
  });

  const entry = getAgentEntry(config, 'zai');

  invariant(entry.baseURL !== undefined, 'expected a gateway entry');

  const adapter = createGatewayAdapter(
    { ...entry, baseURL: entry.baseURL },
    config,
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false, pluginDirs: ['/srv/plugins/extra'] });

  expect(plan.args).toStrictEqual([
    '--settings',
    join(ctx.directory, 'state', 'hook-settings-zai.json'),
    '--plugin-dir',
    join(ctx.directory, 'atc-bridge'),
    '--plugin-dir',
    join(ctx.directory, 'home', 'plugins', 'band'),
    '--plugin-dir',
    '/srv/plugins/extra',
  ]);
});

test("it lists a gateway's configured plugin folders in its profile", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ pluginDirs: ['/opt/plugins/shared'] }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.profile.pluginDirs).toStrictEqual(['/opt/plugins/shared']);
});

test("it keeps the gateway's arguments, its permission mode included, in the command that resumes it outside atc", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'manual-resume',
      bin: '/opt/gw/bin/claude',
      args: ['--permission-mode', 'default'],
      baseURL: 'https://gateway.example/anthropic',
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const command = adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), []);

  expect(command).toBe(
    `cd '/work/repo' && /opt/gw/bin/claude '--permission-mode' 'default' --settings '${join(ctx.directory, 'state', 'hook-settings-manual-resume.json')}' --resume sess-1`,
  );
});

test("it keeps a gateway's configured plugin folders and the session's own in the command that resumes it outside atc", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'plugged',
      bin: '/opt/gw/bin/claude',
      baseURL: 'https://gateway.example/anthropic',
      pluginDirs: ['/opt/plugins/shared'],
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const command = adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), [
    '/srv/plugins/band',
  ]);

  expect(command).toBe(
    `cd '/work/repo' && /opt/gw/bin/claude --settings '${join(ctx.directory, 'state', 'hook-settings-plugged.json')}' --plugin-dir '/opt/plugins/shared' --plugin-dir '/srv/plugins/band' --resume sess-1`,
  );
});

test("it runs a headless turn with a gateway's configured plugin folders before the turn's own", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      bin: '/opt/zai/bin/claude',
      pluginDirs: ['/opt/plugins/shared'],
    }),
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
      claudeBin: '/opt/zai/bin/claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-zai.json'),
    },
    events,
  );
});

test("it runs a headless turn with the gateway's settings file, its permission hook and mode included", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
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
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices({ atcArgv: ['/opt/atc/bin/atc'] }),
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

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-manual-hook.json'), 'utf8'),
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: 'claude',
      permissionMode: 'default',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-manual-hook.json'),
    },
    events,
  );

  expect(settings).toStrictEqual({
    permissions: { defaultMode: 'default' },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='manual-hook'`,
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='manual-hook'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='manual-hook'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='manual-hook'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='manual-hook'`,
              timeout: 5,
            },
          ],
        },
      ],
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'decide-permission' }] }],
    },
    statusLine: {
      type: 'command',
      command: `"/opt/atc/bin/atc" statusline --agent='manual-hook'`,
      padding: 0,
    },
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' },
  });
});

test("it restores a session in the permission mode the gateway's settings default to", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-settings',
      bin: 'claude',
      settings: { permissions: { defaultMode: 'default' } },
    }),
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
      '--permission-mode',
      'default',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-restore-settings.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test("it keeps the gateway's settings default mode in the command that resumes it outside atc", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'resume-settings',
      bin: '/opt/gw/bin/claude',
      baseURL: 'https://gateway.example/anthropic',
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const command = adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), []);

  expect(command).toBe(
    `cd '/work/repo' && /opt/gw/bin/claude '--permission-mode' 'default' --settings '${join(ctx.directory, 'state', 'hook-settings-resume-settings.json')}' --resume sess-1`,
  );
});

test('it restores a gateway in its explicit permission-mode argument over its settings default', () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-flag',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      settings: { permissions: { defaultMode: 'default' } },
    }),
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
      '--permission-mode',
      'plan',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-restore-flag.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
      '--resume',
      'sess-1',
    ],
  });
});

test('it resumes a gateway outside atc in its explicit permission-mode argument over its settings default', () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'restore-flag',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      settings: { permissions: { defaultMode: 'default' } },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const command = adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), []);

  expect(command).toBe(
    `cd '/work/repo' && claude '--permission-mode' 'plan' --settings '${join(ctx.directory, 'state', 'hook-settings-restore-flag.json')}' --resume sess-1`,
  );
});

test("it refuses to start a gateway with auth on the daemon's machine", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(() => adapter.planSpawn({ prompt: '', resume: false })).toThrow(
    expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }),
  );
});

test('it gives a gateway with auth no headless runner', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ id: 'glm', auth: { profiles: ['glm'], placeholderEnv: {} } }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { headlessRun: buildStubClaudeHeadlessRun() },
  );

  expect(adapter.headlessRunner).toBeNull();
});

test('it gives a gateway with auth no resume command', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ id: 'glm', auth: { profiles: ['glm'], placeholderEnv: {} } }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { headlessRun: buildStubClaudeHeadlessRun() },
  );

  expect(adapter.planResumeCommand('/work', toAgentSessionID('a1'), [])).toBeNull();
});

test("it starts a gateway with auth and a credential helper on the daemon's machine under that helper", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm-local',
      bin: 'claude',
      args: ['--plugin-dir', '/home/me/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices({ atcArgv: ['/opt/atc/bin/atc'] }),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false });

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-glm-local.json'), 'utf8'),
  );

  expect(plan).toStrictEqual({
    bin: 'claude',
    args: [
      '--plugin-dir',
      '/home/me/mods/auto-mode',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-glm-local.json'),
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
              command: `"/opt/atc/bin/atc" hook-report --agent='glm-local'`,
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='glm-local'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='glm-local'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='glm-local'`,
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
              command: `"/opt/atc/bin/atc" hook-report --agent='glm-local'`,
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: `"/opt/atc/bin/atc" statusline --agent='glm-local'`,
      padding: 0,
    },
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
    apiKeyHelper: '/home/me/bin/glm-key',
  });
});

test('it writes no broker placeholder into the local settings of a gateway with auth and a credential helper', () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm-local',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      env: {},
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  adapter.planSpawn({ prompt: '', resume: false });

  expect(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-glm-local.json'), 'utf8'),
  ).not.toMatch(/broker-placeholder|ANTHROPIC_AUTH_TOKEN/u);
});

test('it lets a gateway with auth and a credential helper start on a target without a broker', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()?.brokerRequired).toBe(false);
});

test("it runs a headless turn of a gateway with auth and a credential helper through the gateway's settings file", () => {
  const ctx = setupTest();
  const runner = buildStubClaudeHeadlessRun();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    }),
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
    { cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    events,
  );

  expect(runner).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      claudeBin: 'claude',
      permissionMode: 'auto',
      pluginDir: join(ctx.directory, 'atc-bridge'),
      settings: join(ctx.directory, 'state', 'hook-settings-glm.json'),
    },
    events,
  );
});

test('it resumes a gateway with auth and a credential helper outside atc through its settings file', () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    {
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
    },
  );

  expect(adapter.planResumeCommand('/work/repo', toAgentSessionID('sess-1'), [])).toBe(
    `cd '/work/repo' && claude --settings '${join(ctx.directory, 'state', 'hook-settings-glm.json')}' --resume sess-1`,
  );
});

test("it starts a brokered guest with the auth's own arguments in place of the gateway's", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--plugin-dir', '/home/me/mods/auto-mode', '--permission-mode', 'plan'],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: '/home/me/bin/glm-key',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode', '--permission-mode', 'acceptEdits'],
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: 'hi', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const args: readonly unknown[] = plan.args;

  expect(args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--plugin-dir',
    '/opt/auto-mode/mods/auto-mode',
    '--permission-mode',
    'acceptEdits',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
    'hi',
  ]);
});

test('it gives a brokered guest spawn with atc access the guest atc as an MCP server', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false, atcMCP: true },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 4,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const args: readonly unknown[] = plan.args;

  expect(args).toIncludeAllMembers(['--mcp-config', '/tmp/atc/sessions/s1/auth-r4/mcp.json']);

  expect(plan.files['auth-r4/mcp.json']).toBe(
    JSON.stringify(
      { mcpServers: { atc: { type: 'stdio', command: '/opt/atc/bin/atc', args: ['mcp'] } } },
      null,
      2,
    ),
  );
});

test('it gives a brokered guest spawn with atc access two minutes to connect its MCP servers', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false, atcMCP: true },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 4,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.env?.['MCP_TIMEOUT']).toBe('120000');
});

test("it plans a brokered guest spawn whose settings env takes the target's sessionEnv over the gateway's env, under its endpoint and placeholder", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { NOTES_VAULT: 'desk/notes-key', NOTES_REGION: 'north' },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      sessionEnv: { NOTES_VAULT: 'box/notes-key' },
      auth: {
        revision: 4,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  const settingsFile = plan?.files['auth-r4/settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the revision settings file');

  const settings: unknown = JSON.parse(settingsFile);

  invariant(isRecord(settings), 'expected a settings object');

  expect(settings['env']).toStrictEqual({
    NOTES_VAULT: 'box/notes-key',
    NOTES_REGION: 'north',
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
});

test('it plans a brokered guest spawn with its own settings file, Claude config folder and placeholder credential', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const settingsFile = plan.files['auth-r3/settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the revision settings file');

  const onboardingFile = plan.files['claude-config-seed.json'];

  invariant(typeof onboardingFile === 'string', 'expected the Claude config file');

  const settings: unknown = JSON.parse(settingsFile);
  const onboarding: unknown = JSON.parse(onboardingFile);
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
      '/tmp/atc/sessions/s1/claude-config-bundle/none',
      '/tmp/atc/sessions/s1/scratch',
      'claude',
      '--permission-mode',
      'default',
      '--add-dir',
      '/tmp/atc/sessions/s1/scratch',
      '--settings',
      '/tmp/atc/sessions/s1/auth-r3/settings.json',
      '--plugin-dir',
      '/tmp/atc/sessions/s1/atc-bridge',
    ],
    env: {
      CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
      TMPDIR: '/tmp/atc/sessions/s1/scratch',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
    },
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  expect(onboarding).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { '/tmp/atc/sessions/s1/scratch': { hasTrustDialogAccepted: true } },
  });

  expect(plan.files).toStrictEqual({
    'auth-r3/settings.json': settingsFile,
    'claude-config-seed.json': onboardingFile,
    'atc-bridge/.claude-plugin/plugin.json': ATC_BRIDGE_FILES['.claude-plugin/plugin.json'],
    'atc-bridge/hooks/hooks.json': ATC_BRIDGE_FILES['hooks/hooks.json'],
    'atc-bridge/hooks/register.ts': ATC_BRIDGE_FILES['hooks/register.ts'],
    'atc-bridge/hooks/bridge-state.ts': ATC_BRIDGE_FILES['hooks/bridge-state.ts'],
    'atc-bridge/hooks/encode-attribute.ts': ATC_BRIDGE_FILES['hooks/encode-attribute.ts'],
    'atc-bridge/hooks/parse-tap-line.ts': ATC_BRIDGE_FILES['hooks/parse-tap-line.ts'],
    'atc-bridge/hooks/run-tap.ts': ATC_BRIDGE_FILES['hooks/run-tap.ts'],
    'atc-bridge/hooks/schedule-answered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-answered-report.ts'],
    'atc-bridge/hooks/schedule-delivery.ts': ATC_BRIDGE_FILES['hooks/schedule-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-delivery.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-delivery.ts'],
    'atc-bridge/hooks/schedule-notice-reminder.ts':
      ATC_BRIDGE_FILES['hooks/schedule-notice-reminder.ts'],
    'atc-bridge/hooks/schedule-unanswered-report.ts':
      ATC_BRIDGE_FILES['hooks/schedule-unanswered-report.ts'],
    'atc-bridge/hooks/try-update-conversation.ts':
      ATC_BRIDGE_FILES['hooks/try-update-conversation.ts'],
    'atc-bridge/hooks/update-turn-completed.ts': ATC_BRIDGE_FILES['hooks/update-turn-completed.ts'],
    'atc-bridge/hooks/update-turn-started.ts': ATC_BRIDGE_FILES['hooks/update-turn-started.ts'],
    'atc-bridge/hooks/wait-for-step-end.ts': ATC_BRIDGE_FILES['hooks/wait-for-step-end.ts'],
    'atc-bridge/hooks/atc-cli.ts':
      'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  });
});

test("it keeps the gateway's permission hook and mode in a brokered guest's settings and restore arguments", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const hook = { matcher: '.*', hooks: [{ type: 'command', command: 'classify', timeout: 90 }] };

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      settings: { permissions: { defaultMode: 'default' }, hooks: { PermissionRequest: [hook] } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const settingsFile = plan.files['auth-r1/settings.json'];

  invariant(typeof settingsFile === 'string', 'expected the revision settings file');

  const settings: unknown = JSON.parse(settingsFile);
  const args: readonly unknown[] = plan.args;

  expect(args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--permission-mode',
    'default',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
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
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 5,
            },
          ],
        },
      ],
      PermissionRequest: [hook],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test.each([
  [{ ANTHROPIC_API_KEY: 'broker-placeholder' }],
  [{}],
  [{ ANTHROPIC_AUTH_TOKEN: 'broker-placeholder', ANTHROPIC_API_KEY: 'broker-placeholder' }],
  [
    {
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
    },
  ],
  [{ ANTHROPIC_AUTH_TOKEN: 'broker-placeholder', CLAUDE_CONFIG_DIR: 'broker-placeholder' }],
  [{ ANTHROPIC_AUTH_TOKEN: 'sk-real' }],
])('it refuses a brokered guest spawn whose placeholders are %p', (placeholderEnv) => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: placeholderEnv, profileEnv: {} },
      },
    ),
  ).toThrow(
    expect.objectContaining({ code: 'auth_placeholder_unsupported', data: { agent: 'glm' } }),
  );
});

test('it allows the start of a gateway with auth that sets an extra placeholder variable', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'jev'],
        placeholderEnv: {
          ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
          TYPESAFE_API_KEY: 'broker-placeholder',
        },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        jev: {
          secret: 'jev-agents',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
    }),
    buildMockHostServices(),
  );

  expect(adapter.findSpawnRefusal()).toBeNull();
});

test('it carries an extra placeholder variable and the gateway args into a brokered guest launch', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--plugin-dir', '/opt/auto-mode/mods/auto-mode'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'jev'],
        placeholderEnv: {
          ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
          TYPESAFE_API_KEY: 'broker-placeholder',
        },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        jev: {
          secret: 'jev-agents',
          host: 'api.typesafe.ai',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {
          ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
          TYPESAFE_API_KEY: 'broker-placeholder',
        },
        profileEnv: {},
      },
    },
  );

  const settingsFile = plan?.files['auth-r1/settings.json'];

  invariant(
    plan !== null && typeof settingsFile === 'string',
    'expected a guest spawn plan with a settings file',
  );

  const settings: unknown = JSON.parse(settingsFile);
  const args: readonly unknown[] = plan.args;

  expect(args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--plugin-dir',
    '/opt/auto-mode/mods/auto-mode',
    '--permission-mode',
    'default',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
    TYPESAFE_API_KEY: 'broker-placeholder',
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      TYPESAFE_API_KEY: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test("it refuses a brokered guest spawn whose profile sets a header other than a bearer authorization for the base URL's host", () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    ),
  ).toThrow(
    expect.objectContaining({ code: 'auth_placeholder_unsupported', data: { agent: 'glm' } }),
  );
});

test('it refuses a brokered guest spawn on a host that gave it no broker binding', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(() =>
    adapter.planGuestSpawn(
      { prompt: '', resume: false },
      { atc: '/opt/atc/bin/atc', directory: '/tmp/atc/sessions/s1' },
    ),
  ).toThrow(expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }));
});

test('it plans no guest spawn for a gateway whose credential helper runs on the daemon machine', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'zai-key',
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan).toBeNull();
});

test('it plans no brokered guest spawn on a host without atc', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: null,
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
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

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: `echo ${canary}`,
      settings: { apiKeyHelper: `echo ${canary}`, env: { ANTHROPIC_API_KEY: canary } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  expect(JSON.stringify(plan)).not.toMatch(/canary-sk-7f3e9b21d4c8a6|apiKeyHelper/u);
});

test("it seeds a brokered guest's Claude config with the onboarding state when the folder holds none", async () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'true',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: ctx.directory,
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const seed = plan.files['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected the seed file');
  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), seed);

  const result = await run([plan.bin, ...plan.args]);

  const seeded = readFileSync(join(ctx.directory, 'claude-config', '.claude.json'), 'utf8');

  expect(result.exitCode).toBe(0);

  expect(JSON.parse(seeded)).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { [join(ctx.directory, 'scratch')]: { hasTrustDialogAccepted: true } },
  });
});

test("it keeps the state an earlier run left in a brokered guest's Claude config and marks the outside-read offer seen", async () => {
  const ctx = setupTest();

  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'true',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      directory: ctx.directory,
      auth: {
        revision: 2,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const earlier = JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { '/work': { hasTrustDialogAccepted: true } },
  });

  const seed = plan.files['claude-config-seed.json'];

  invariant(typeof seed === 'string', 'expected the seed file');
  writeFileSync(join(ctx.directory, 'claude-config-seed.json'), seed);
  mkdirSync(join(ctx.directory, 'claude-config'));
  writeFileSync(join(ctx.directory, 'claude-config', '.claude.json'), earlier);

  const result = await run([plan.bin, ...plan.args]);

  const merged = readFileSync(join(ctx.directory, 'claude-config', '.claude.json'), 'utf8');

  expect(result.exitCode).toBe(0);

  expect(JSON.parse(merged)).toStrictEqual({
    hasSeenAutoModeOutsideReadPrompt: true,
    hasCompletedOnboarding: true,
    projects: { '/work': { hasTrustDialogAccepted: true } },
  });
});

test('it starts a brokered guest in the permission mode its configured arguments set', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      args: ['--permission-mode', 'plan'],
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--permission-mode',
    'plan',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);
});

test("it starts a fresh spawn of a brokered guest in Claude's manual mode when the gateway sets none", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--permission-mode',
    'default',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
  ]);
});

test("it starts a resume of a brokered guest in Claude's manual mode when the gateway sets none", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: toAgentSessionID('a1') },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
      },
    },
  );

  expect(plan?.args).toStrictEqual([
    '-c',
    expect.any(String),
    'sh',
    '/tmp/atc/sessions/s1/claude-config',
    '/tmp/atc/sessions/s1/claude-config-seed.json',
    '/tmp/atc/sessions/s1/claude-config-bundle',
    '/tmp/atc/sessions/s1/claude-config-bundle/none',
    '/tmp/atc/sessions/s1/scratch',
    'claude',
    '--permission-mode',
    'default',
    '--add-dir',
    '/tmp/atc/sessions/s1/scratch',
    '--settings',
    '/tmp/atc/sessions/s1/auth-r1/settings.json',
    '--plugin-dir',
    '/tmp/atc/sessions/s1/atc-bridge',
    '--resume',
    'a1',
  ]);
});

test('it selects the credential a gateway with auth takes from the broker, with the auth profiles it resolves against', () => {
  const config = parseConfig([CLAUDE_PLUGIN], {
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
  });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    config,
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    },
    profiles: config.authProfiles,
    brokerRequired: true,
  });
});

test('it selects no broker credential for a gateway without auth', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'zai',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
    }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it allows the start of a gateway with auth whose placeholder pairs with the bearer header', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  expect(adapter.findSpawnRefusal()).toBeNull();
});

test('it refuses every start of a gateway with auth whose API key placeholder meets a bearer authorization rule', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  expect(adapter.findSpawnRefusal()).toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'glm' },
  });
});

test('it allows the start of a gateway with auth whose API key placeholder pairs with a raw x-api-key header', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'muse',
      bin: 'claude',
      baseURL: 'https://api.meta.ai',
      auth: {
        profiles: ['muse'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        muse: { secret: 'muse', host: 'api.meta.ai', header: 'x-api-key', scheme: 'raw' },
      },
    }),
    buildMockHostServices(),
  );

  expect(adapter.findSpawnRefusal()).toBeNull();
});

test.each([
  [{ ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' }, { header: 'x-api-key', scheme: 'raw' }],
  [{ ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' }, { header: 'authorization', scheme: 'raw' }],
  [{ ANTHROPIC_API_KEY: 'broker-placeholder' }, { header: 'x-api-key', scheme: 'bearer' }],
  [{ ANTHROPIC_API_KEY: 'broker-placeholder' }, { header: 'authorization', scheme: 'raw' }],
  [
    { ANTHROPIC_API_KEY: 'broker-placeholder', ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
    { header: 'x-api-key', scheme: 'raw' },
  ],
  [{ ANTHROPIC_API_KEY: 'sk-real' }, { header: 'x-api-key', scheme: 'raw' }],
  [
    {
      ANTHROPIC_API_KEY: 'broker-placeholder',
      CLAUDE_CODE_OAUTH_TOKEN: 'broker-placeholder',
    },
    { header: 'x-api-key', scheme: 'raw' },
  ],
])(
  'it refuses every start of a gateway with auth whose placeholders %p meet the rule %p',
  (placeholderEnv, rule) => {
    const adapter = createGatewayAdapter(
      buildMockGatewayConfig({
        id: 'muse',
        bin: 'claude',
        baseURL: 'https://api.meta.ai',
        auth: { profiles: ['muse'], placeholderEnv },
      }),
      parseConfig([CLAUDE_PLUGIN], {
        authProfiles: { muse: { secret: 'muse', host: 'api.meta.ai', ...rule } },
      }),
      buildMockHostServices(),
    );

    expect(adapter.findSpawnRefusal()).toMatchObject({
      code: 'auth_placeholder_unsupported',
      data: { agent: 'muse' },
    });
  },
);

test('it plans a brokered guest spawn of an API key gateway that sends only the x-api-key placeholder, approved in its seed', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'muse',
      bin: 'claude',
      baseURL: 'https://api.meta.ai',
      auth: {
        profiles: ['muse'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        muse: { secret: 'muse', host: 'api.meta.ai', header: 'x-api-key', scheme: 'raw' },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: { ANTHROPIC_API_KEY: 'broker-placeholder' }, profileEnv: {} },
    },
  );

  invariant(plan !== null, 'expected a guest spawn plan');

  const settingsFile = plan.files['auth-r1/settings.json'];
  const seedFile = plan.files['claude-config-seed.json'];

  invariant(typeof settingsFile === 'string', 'expected the revision settings file');
  invariant(typeof seedFile === 'string', 'expected the seed file');

  const settings: unknown = JSON.parse(settingsFile);
  const seed: unknown = JSON.parse(seedFile);

  expect(plan.env).toStrictEqual({
    CLAUDE_CONFIG_DIR: '/tmp/atc/sessions/s1/claude-config',
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
    ANTHROPIC_API_KEY: 'broker-placeholder',
  });

  expect(settings).toMatchObject({
    env: {
      ANTHROPIC_BASE_URL: 'https://api.meta.ai',
      ANTHROPIC_API_KEY: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  expect(settings).not.toHaveProperty(['env', 'ANTHROPIC_AUTH_TOKEN']);

  expect(seed).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    customApiKeyResponses: { approved: ['broker-placeholder'], rejected: [] },
    projects: { '/tmp/atc/sessions/s1/scratch': { hasTrustDialogAccepted: true } },
  });
});

test('it seeds the approval of the API key placeholder beside the clone trust of an API key gateway', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'muse',
      bin: 'claude',
      baseURL: 'https://api.meta.ai',
      auth: {
        profiles: ['muse'],
        placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        muse: { secret: 'muse', host: 'api.meta.ai', header: 'x-api-key', scheme: 'raw' },
      },
    }),
    buildMockHostServices(),
  );

  const seedFile = adapter.planGuestWorkspaceTrust('/work/repo', '/guest/s1')?.[
    'claude-config-seed.json'
  ];

  invariant(typeof seedFile === 'string', 'expected the seed file');

  expect(JSON.parse(seedFile)).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    customApiKeyResponses: { approved: ['broker-placeholder'], rejected: [] },
    projects: {
      '/guest/s1/scratch': { hasTrustDialogAccepted: true },
      '/work/repo': { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true },
    },
  });
});

test.each([
  [{ ANTHROPIC_AUTH_TOKEN: 'sk-host' }, 78],
  [{}, 0],
])(
  'it starts a brokered guest of an API key gateway under the host environment %p with exit code %p',
  async (hostEnv, exitCode) => {
    const ctx = setupTest();

    const adapter = createGatewayAdapter(
      buildMockGatewayConfig({
        id: 'muse',
        bin: 'true',
        baseURL: 'https://api.meta.ai',
        auth: {
          profiles: ['muse'],
          placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
        },
      }),
      parseConfig([CLAUDE_PLUGIN], {
        authProfiles: {
          muse: { secret: 'muse', host: 'api.meta.ai', header: 'x-api-key', scheme: 'raw' },
        },
      }),
      buildMockHostServices(),
    );

    const plan = adapter.planGuestSpawn(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc/bin/atc',
        directory: ctx.directory,
        auth: {
          revision: 1,
          env: { ANTHROPIC_API_KEY: 'broker-placeholder' },
          profileEnv: {},
        },
      },
    );

    invariant(plan !== null, 'expected a guest spawn plan');

    const seed = plan.files['claude-config-seed.json'];

    invariant(typeof seed === 'string', 'expected the seed file');
    writeFileSync(join(ctx.directory, 'claude-config-seed.json'), seed);

    const result = await run([plan.bin, ...plan.args], {
      env: { PATH: process.env['PATH'], ...hostEnv, ...plan.env },
    });

    expect(result.exitCode).toBe(exitCode);
  },
);

test('it refuses every start of a gateway with auth whose env sets a proxy variable', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      settings: { env: { https_proxy: 'http://proxy.example:3128' } },
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
      },
    }),
    buildMockHostServices(),
  );

  expect(adapter.findSpawnRefusal()).toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', problem: 'guest_env_conflict', variable: 'https_proxy' },
  });
});

test('it pastes a long line and submits it with a carriage return as a second write', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
  );

  expect(adapter.planLineInput('a'.repeat(1600), { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}${'a'.repeat(1600)}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test("it sets a profile's variables in a brokered guest's settings env and spawn env", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'op'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {
          OP_CONNECT_HOST: 'https://op-connect.example.com',
          OP_CONNECT_TOKEN: 'broker-placeholder',
        },
      },
    },
  );

  const settingsFile = plan?.files['auth-r3/settings.json'];

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
    ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 30,
            },
          ],
        },
        {
          hooks: [
            { type: 'command', command: expect.stringContaining('CLAUDE_ENV_FILE'), timeout: 5 },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
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
              command: '"/opt/atc/bin/atc" hook-report --agent=\'glm\'',
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: '"/opt/atc/bin/atc" statusline --agent=\'glm\'',
      padding: 0,
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      OP_CONNECT_HOST: 'https://op-connect.example.com',
      OP_CONNECT_TOKEN: 'broker-placeholder',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test('it refuses a local plan of a gateway whose profile sets variables', () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'op'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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
    }),
    buildMockHostServices(),
  );

  expect(() => adapter.planSpawn({ prompt: '', resume: false })).toThrow(
    expect.objectContaining({ code: 'auth_target_unsupported', data: { agent: 'glm' } }),
  );
});

test("it sets the telemetry variables for the binding's telemetry host in a brokered guest's settings env and spawn env", () => {
  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({
      id: 'glm',
      bin: 'claude',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm', 'records'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
      },
    }),
    parseConfig([CLAUDE_PLUGIN], {
      authProfiles: {
        glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        records: {
          secret: 'records',
          host: 'records.example.com',
          header: 'authorization',
          scheme: 'bearer',
          telemetry: { logs: true },
        },
      },
    }),
    buildMockHostServices(),
  );

  const plan = adapter.planGuestSpawn(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc/bin/atc',
      directory: '/work/sessions/s1',
      auth: {
        revision: 3,
        env: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
        profileEnv: {},
        telemetryHost: 'records.example.com',
      },
    },
  );

  const settingsFile = plan?.files['auth-r3/settings.json'];

  invariant(
    plan !== null && typeof settingsFile === 'string',
    'expected a guest spawn plan with a settings file',
  );

  const settings = z
    .object({ env: z.record(z.string(), z.string()) })
    .parse(JSON.parse(settingsFile));

  expect({ spawn: plan.env, settings: settings.env }).toStrictEqual({
    spawn: {
      CLAUDE_CONFIG_DIR: '/work/sessions/s1/claude-config',
      TMPDIR: '/work/sessions/s1/scratch',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://records.example.com',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
    },
    settings: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://records.example.com',
      ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
});

test("it plans a local session's scratch folder as its scratch", () => {
  const ctx = setupTest();

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { stateDir: join(ctx.directory, 'state'), homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false }, toSessionID('s1'));

  expect(plan.scratch).toBe(join(ctx.directory, 'state', 'sessions', 's1', 'scratch'));
});

test("it trusts a local session's scratch folder in the user's Claude config", async () => {
  const ctx = setupTest();
  const homeDir = join(ctx.directory, 'home');
  const scratch = join(ctx.directory, 'state', 'sessions', 's1', 'scratch');

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(homeDir, { recursive: true });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig(),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { homeDir },
  );

  await adapter.trustLocalScratch(scratch);

  const written: unknown = JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8'));

  expect(written).toStrictEqual({ projects: { [scratch]: { hasTrustDialogAccepted: true } } });
});

test("it trusts a local session's scratch folder in the config folder the gateway's env names", async () => {
  const ctx = setupTest();
  const homeDir = join(ctx.directory, 'home');
  const configDir = join(ctx.directory, 'gateway-config');
  const scratch = join(ctx.directory, 'state', 'sessions', 's1', 'scratch');

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ env: { CLAUDE_CONFIG_DIR: configDir } }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { homeDir },
  );

  await adapter.trustLocalScratch(scratch);

  const written: unknown = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'));

  expect(written).toStrictEqual({ projects: { [scratch]: { hasTrustDialogAccepted: true } } });
  expect(existsSync(join(homeDir, '.claude.json'))).toBeFalse();
});

test("it trusts a relative config folder at the path the launch's settings name", async () => {
  const ctx = setupTest();
  const scratch = join(ctx.directory, 'state', 'sessions', 's1', 'scratch');
  const relativeDir = join(relative(process.cwd(), ctx.directory), 'relative-config');
  const configDir = resolve(relativeDir);

  updateEnv('CLAUDE_CONFIG_DIR', undefined);
  mkdirSync(configDir, { recursive: true });

  const adapter = createGatewayAdapter(
    buildMockGatewayConfig({ env: { CLAUDE_CONFIG_DIR: relativeDir } }),
    parseConfig([CLAUDE_PLUGIN], {}),
    buildMockHostServices(),
    { stateDir: join(ctx.directory, 'state'), homeDir: join(ctx.directory, 'home') },
  );

  const plan = adapter.planSpawn({ prompt: '', resume: false }, toSessionID('s1'));
  const settingsPath = plan.args[plan.args.indexOf('--settings') + 1];

  invariant(settingsPath !== undefined, 'the plan passes a settings file');

  const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));

  await adapter.trustLocalScratch(scratch);

  const written: unknown = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'));

  expect(settings).toMatchObject({ env: { CLAUDE_CONFIG_DIR: configDir } });
  expect(written).toStrictEqual({ projects: { [scratch]: { hasTrustDialogAccepted: true } } });
});
