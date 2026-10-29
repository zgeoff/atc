import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { readLocalMatchingLines } from '@atc/plugin-api';
import {
  buildStubMessageBridgeHost,
  createStubAppServerCodex,
  getAgentEntry,
  setupTempDir,
  updateEnv,
} from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { CODEX_PLUGIN } from './codex-plugin';
import { createCodexAdapter } from './create-codex-adapter';

// A folder for the files a test writes: a Codex home with its session index,
// or a rollout.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-');

  return { directory: temporaryDirectory.path };
}

test('it spawns a fresh codex command with the prompt', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planSpawn({ prompt: 'fix the bug', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['--no-daemon', 'fix the bug'],
  });
});

test('it spawns codex resume with the picker when no id was captured', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: true })).toStrictEqual({
    bin: 'codex',
    args: ['--no-daemon', 'resume'],
  });
});

test('it spawns codex resume with the captured id', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: toAgentSessionID('c-1') })).toStrictEqual({
    bin: 'codex',
    args: ['--no-daemon', 'resume', 'c-1'],
  });
});

test('it keeps the configured codex arguments when a spawn sets no model', () => {
  const config = parseConfig([CODEX_PLUGIN], { agents: { codex: { args: ['--model', 'gpt-a'] } } });
  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['--no-daemon', '--model', 'gpt-a'],
  });
});

test("it replaces the configured codex model with a spawn's model passed as -m", () => {
  const config = parseConfig([CODEX_PLUGIN], {
    agents: { codex: { args: ['--model', 'gpt-a', '--search'] } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'));

  expect(
    adapter.planSpawn({ prompt: 'go', resume: toAgentSessionID('c-1'), model: 'gpt-b' }),
  ).toStrictEqual({
    bin: 'codex',
    args: ['--no-daemon', '--search', '-m', 'gpt-b', 'resume', 'c-1', 'go'],
  });
});

test.each([
  ['--remote', ['--remote', 'ws://127.0.0.1:4500']],
  ['--remote=', ['--remote=ws://127.0.0.1:4500']],
  ['--no-daemon', ['--no-daemon', '-m', 'gpt-a']],
])('it adds no --no-daemon of its own when the configured arguments hold %s', (_spelling, args) => {
  const adapter = createCodexAdapter(
    getAgentEntry(parseConfig([CODEX_PLUGIN], { agents: { codex: { args } } }), 'codex'),
  );

  expect(adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'codex',
    args,
  });
});

test('it advertises a codex model with the configured default and no effort', () => {
  const config = parseConfig([CODEX_PLUGIN], { agents: { codex: { args: ['-m', 'gpt-a'] } } });
  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'));

  expect(adapter.profile.spawnOptions).toStrictEqual({
    model: {
      supported: true,
      values: null,
      examples: [],
      default: 'gpt-a',
      backendEffect: 'applied',
      note: 'A model name, passed as -m.',
    },
    effort: {
      supported: false,
      values: null,
      examples: [],
      default: null,
      backendEffect: null,
      note: 'Codex documents its reasoning effort levels as depending on the model, with no closed list, so atc does not pass one.',
    },
  });
});

test('it plans one event for a hook line and records no thread before a session start', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  const plan = adapter.planHookEvents(
    {
      atcId: toSessionID('s1'),
      event: 'PermissionRequest',
      payload: { session_id: 'c-1', tool_name: 'shell' },
    },
    undefined,
  );

  expect(plan).toStrictEqual({
    events: [
      {
        kind: 'needs-input',
        agentSessionID: toAgentSessionID('c-1'),
        message: 'waiting for approval: shell',
        detail: 'waiting for approval: shell',
      },
    ],
  });
});

test('it loads the latest indexed thread name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
      '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
    ].join('\n'),
  );

  const adapter = createCodexAdapter(
    getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'),
    undefined,
    ctx.directory,
  );

  const name = await adapter.loadName('c-1', 'auto', {
    files: { readMatchingLines: readLocalMatchingLines },
    agentHome: null,
  });

  expect(name).toStrictEqual({ name: 'renamed title' });
});

test('it loads the indexed thread name from CODEX_HOME when built without a Codex home', async () => {
  const ctx = setupTest();

  updateEnv('CODEX_HOME', ctx.directory);

  writeFileSync(
    join(ctx.directory, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"env title","updated_at":"2026-08-20T00:00:00Z"}\n',
  );

  const config = parseConfig([CODEX_PLUGIN], {});
  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const name = await adapter.loadName('c-1', 'auto', {
    files: { readMatchingLines: readLocalMatchingLines },
    agentHome: null,
  });

  expect(name).toStrictEqual({ name: 'env title' });
});

test('it loads the indexed thread name from the agent home the session launched with', async () => {
  const ctx = setupTest();
  const guestHome = join(ctx.directory, 'guest-home');

  mkdirSync(guestHome);

  writeFileSync(
    join(guestHome, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"guest title","updated_at":"2026-08-20T00:00:00Z"}\n',
  );

  const adapter = createCodexAdapter(
    getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'),
    undefined,
    ctx.directory,
  );

  const name = await adapter.loadName('c-1', 'auto', {
    files: { readMatchingLines: readLocalMatchingLines },
    agentHome: guestHome,
  });

  expect(name).toStrictEqual({ name: 'guest title' });
});

test('it does not resume when the reported rollout is gone', () => {
  const ctx = setupTest();
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.canResume({ transcriptSource: join(ctx.directory, 'missing.jsonl') })).toBeFalse();
});

test('it builds a codex resume command with a captured id', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planResumeCommand("/tmp/it's", toAgentSessionID('c-1'))).toBe(
    String.raw`cd '/tmp/it'\''s' && codex resume c-1`,
  );
});

test('it builds a codex resume command with the picker when no id was captured', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planResumeCommand('/tmp', undefined)).toBe(`cd '/tmp' && codex resume`);
});

test('it refuses inbox messages without an App Server', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.takesMessages).toBeFalse();
  expect(adapter.startMessageBridge).toBeUndefined();
});

test('it takes inbox messages on an App Server', () => {
  const adapter = createCodexAdapter(
    getAgentEntry(parseConfig([CODEX_PLUGIN], { agents: { codex: { appServer: true } } }), 'codex'),
  );

  expect(adapter.takesMessages).toBeTrue();
});

test("it starts the session's App Server and plans the terminal on the bridge's thread", async () => {
  const ctx = setupTest();
  const bin = createStubAppServerCodex(ctx.directory);

  const adapter = createCodexAdapter(
    getAgentEntry(
      parseConfig([CODEX_PLUGIN], {
        agents: {
          codex: { appServer: true, bin, args: ['--no-daemon', '--search', '-m', 'gpt-a'] },
        },
      }),
      'codex',
    ),
  );

  invariant(adapter.startMessageBridge);

  const bridge = await adapter.startMessageBridge({
    session: toSessionID('s-1'),
    cwd: ctx.directory,
    env: {},
    withheldEnv: [],
    options: { prompt: 'fix the bug', resume: false, model: 'gpt-b' },
    directory: join(ctx.directory, 'bridge'),
    host: buildStubMessageBridgeHost().host,
  });

  onTestFinished(() => bridge.stop());

  expect(bridge.plan).toStrictEqual({
    bin,
    args: [
      '--search',
      '-m',
      'gpt-b',
      'resume',
      'thread-1',
      '--remote',
      `unix://${join(ctx.directory, 'bridge', 'codex.sock')}`,
      'fix the bug',
    ],
  });
});

test('it selects the ChatGPT endpoint and its profiles for an entry with auth, without requiring the broker', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'codex',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      auth: { profiles: ['codex', 'github'], placeholderEnv: {} },
    },
    profiles: config.authProfiles,
    brokerRequired: false,
  });
});

test('it selects no credential for an entry without auth', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it plans no guest spawn of its own for an entry without auth', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planGuestSpawn).toBeUndefined();
});

test('it plans a remote spawn with auth but without the broker as a local spawn with no files', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: false },
    {
      atc: null,
      directory: '/tmp/atc/sessions/s1',
    },
  );

  expect(plan).toStrictEqual({ bin: 'codex', args: ['--no-daemon', 'go'], files: {} });
});

test('it plans a spawn behind the broker with a Codex home of its own and hooks it trusts at launch', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: toAgentSessionID('c-1') },
    {
      atc: '/opt/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 2,
        env: {},
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

  expect({
    bin: plan?.bin,
    args: plan?.args,
    env: plan?.env,
    files: plan?.files,
  }).toStrictEqual({
    bin: 'sh',
    args: [
      '-c',
      expect.any(String),
      'sh',
      '/tmp/atc/sessions/s1/codex-home',
      '/tmp/atc/sessions/s1/auth-r2',
      '/tmp/atc/sessions/s1/codex-trust.toml',
      'codex',
      '--dangerously-bypass-hook-trust',
      '-c',
      'cli_auth_credentials_store="file"',
      '--no-daemon',
      'resume',
      'c-1',
      'go',
    ],
    env: { CODEX_HOME: '/tmp/atc/sessions/s1/codex-home' },
    files: {
      'auth-r2/auth.json': `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
      'auth-r2/config.toml':
        'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
      'auth-r2/hooks.json': `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  { type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 },
                ],
              },
            ],
            PermissionRequest: [
              {
                hooks: [
                  { type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  { type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  { type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 3 },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    },
  });
});

test("it keeps its own Codex home over a profile's variables", () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: false },
    {
      atc: '/opt/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {},
        profileEnv: { CODEX_HOME: '/elsewhere', OP_CONNECT_HOST: 'https://op.example.com' },
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

  expect(plan?.env).toStrictEqual({
    CODEX_HOME: '/tmp/atc/sessions/s1/codex-home',
    OP_CONNECT_HOST: 'https://op.example.com',
  });
});

test("it writes the sign-in file from the oauth secret's claims and account id", () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {},
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

  const file = plan?.files['auth-r1/auth.json'];

  invariant(typeof file === 'string', 'the plan stages no sign-in file');

  expect(JSON.parse(file)).toStrictEqual({
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

test('it reports every hook through the atc inside the host', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {},
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

  const hooks = plan?.files['auth-r1/hooks.json'];

  invariant(typeof hooks === 'string', 'the plan stages no hook file');

  expect(JSON.parse(hooks)).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 }],
        },
      ],
      PermissionRequest: [
        {
          hooks: [{ type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 5 }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{ type: 'command', command: '"/opt/atc" hook-report --agent codex', timeout: 3 }],
        },
      ],
    },
  });
});

test('it plans no spawn behind the broker on a host without atc', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: null,
      directory: '/tmp/atc/sessions/s1',
      auth: {
        revision: 1,
        env: {},
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

  expect(plan).toBeNull();
});

test.each<['needs_login' | 'pending']>([['needs_login'], ['pending']])(
  'it refuses a spawn whose sign-in is %s',
  (status) => {
    const config = parseConfig([CODEX_PLUGIN], {
      authProfiles: {
        codex: {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        },
        github: { secret: 'github-agents', kind: 'github' },
      },
      agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
    });

    const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

    const plan = () =>
      adapter.planGuestSpawn?.(
        { prompt: '', resume: false },
        {
          atc: '/opt/atc',
          directory: '/tmp/atc/sessions/s1',
          auth: {
            revision: 1,
            env: {},
            profileEnv: {},
            oauth: {
              'codex-chatgpt': {
                status,
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

    expect(plan).toThrow(
      expect.objectContaining({
        code: 'auth_signin_needed',
        message: `agent 'codex' signs in through codex-chatgpt, whose sign-in in the broker is ${status}; sign Codex in again and give the broker the new refresh token for codex-chatgpt`,
        data: { agent: 'codex', secret: 'codex-chatgpt', status },
      }),
    );
  },
);

test('it refuses a spawn whose sign-in the broker does not list', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = () =>
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: {}, profileEnv: {}, oauth: {} },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_signin_needed',
      message:
        "agent 'codex' signs in through codex-chatgpt, whose sign-in in the broker is not listed; sign Codex in again and give the broker the new refresh token for codex-chatgpt",
      data: { agent: 'codex', secret: 'codex-chatgpt', status: null },
    }),
  );
});

test.each([
  [null],
  [{ email: 'someone@example.com' }],
  [{ 'https://api.openai.com/auth': { chatgpt_account_id: '' } }],
])('it refuses a spawn whose ID token claims are %p', (idClaims) => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = () =>
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc',
        directory: '/tmp/atc/sessions/s1',
        auth: {
          revision: 1,
          env: {},
          profileEnv: {},
          oauth: { 'codex-chatgpt': { status: 'ready', idClaims } },
        },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_signin_needed',
      message:
        "agent 'codex' signs in through codex-chatgpt, whose ID token in the broker holds no ChatGPT account id; sign Codex in again and give the broker the new refresh token for codex-chatgpt",
      data: { agent: 'codex', secret: 'codex-chatgpt', status: 'ready' },
    }),
  );
});

test('it seeds clone trust for an entry with auth', () => {
  const config = parseConfig([CODEX_PLUGIN], {
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = createCodexAdapter(getAgentEntry(config, 'codex'), config);

  expect(adapter.planGuestWorkspaceTrust('/work')).toStrictEqual({
    'codex-trust.toml': '\n[projects."/work"]\ntrust_level = "trusted"\n',
  });
});

test('it seeds no clone trust for an entry without auth', () => {
  const adapter = createCodexAdapter(getAgentEntry(parseConfig([CODEX_PLUGIN], {}), 'codex'));

  expect(adapter.planGuestWorkspaceTrust('/work')).toBeNull();
});

test('it refuses a resume through the session picker on an App Server', () => {
  const ctx = setupTest();

  const adapter = createCodexAdapter(
    getAgentEntry(parseConfig([CODEX_PLUGIN], { agents: { codex: { appServer: true } } }), 'codex'),
  );

  invariant(adapter.startMessageBridge);

  expect(
    adapter.startMessageBridge({
      session: toSessionID('s-1'),
      cwd: ctx.directory,
      env: {},
      withheldEnv: [],
      options: { prompt: '', resume: true },
      directory: join(ctx.directory, 'bridge'),
      host: buildStubMessageBridgeHost().host,
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});
