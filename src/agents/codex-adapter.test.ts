import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { CodexAdapter } from './codex-adapter';

// A folder for the files a test writes: a Codex home with its session index,
// or a rollout.
function setupTest() {
  return setupTempDir('atc-codex-');
}

test('it spawns a fresh codex command with the prompt', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planSpawn({ prompt: 'fix the bug', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['fix the bug'],
  });
});

test('it spawns codex resume with the picker when no id was captured', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: true })).toStrictEqual({
    bin: 'codex',
    args: ['resume'],
  });
});

test('it spawns codex resume with the captured id', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: toAgentSessionID('c-1') })).toStrictEqual({
    bin: 'codex',
    args: ['resume', 'c-1'],
  });
});

test('it keeps the configured codex arguments when a spawn sets no model', () => {
  const config = parseConfig({ codexArgs: ['--model', 'gpt-a'] });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'));

  expect(adapter.planSpawn({ prompt: '', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['--model', 'gpt-a'],
  });
});

test("it replaces the configured codex model with a spawn's model passed as -m", () => {
  const config = parseConfig({ codexArgs: ['--model', 'gpt-a', '--search'] });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'));

  expect(
    adapter.planSpawn({ prompt: 'go', resume: toAgentSessionID('c-1'), model: 'gpt-b' }),
  ).toStrictEqual({ bin: 'codex', args: ['--search', '-m', 'gpt-b', 'resume', 'c-1', 'go'] });
});

test('it advertises a codex model with the configured default and no effort', () => {
  const config = parseConfig({ codexArgs: ['-m', 'gpt-a'] });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'));

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

test('it maps a codex session start to started with id, name, and transcript sources', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: {
      session_id: 'c-1',
      transcript_path: '/tmp/rollout-c-1.jsonl',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
    },
  });

  expect(ev).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    transcriptSource: '/tmp/rollout-c-1.jsonl',
  });
});

test('it maps a codex prompt submit to prompt-submitted', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { session_id: 'c-1', prompt: 'do the thing' },
  });

  expect(ev).toStrictEqual({
    kind: 'prompt-submitted',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    message: 'do the thing',
    detail: 'do the thing',
  });
});

test('it maps a codex stop to turn-done', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'pong' },
  });

  expect(ev).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    detail: 'pong',
    result: 'pong',
  });
});

test('it maps a codex permission request to needs-input', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: 'c-1', tool_name: 'shell' },
  });

  expect(ev).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    message: 'waiting for approval: shell',
    detail: 'waiting for approval: shell',
  });
});

test('it maps a codex session end to ended', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionEnd',
    payload: { session_id: 'c-1', reason: 'other' },
  });

  expect(ev).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it loads the latest indexed thread name', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
      '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
    ].join('\n'),
  );

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'), undefined, ctx.dir);

  const name = await adapter.loadName('c-1', 'auto');

  expect(name).toStrictEqual({ name: 'renamed title' });
});

test('it loads the indexed thread name from CODEX_HOME when built without a Codex home', async () => {
  using ctx = setupTest();

  updateEnv('CODEX_HOME', ctx.dir);

  writeFileSync(
    join(ctx.dir, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"env title","updated_at":"2026-08-20T00:00:00Z"}\n',
  );

  const config = parseConfig({});

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const name = await adapter.loadName('c-1', 'auto');

  expect(name).toStrictEqual({ name: 'env title' });
});

test('it never loads an indexed thread name over a user-typed name', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
      '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
    ].join('\n'),
  );

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'), undefined, ctx.dir);

  const name = await adapter.loadName('c-1', 'user');

  expect(name).toBeNull();
});

test('it loads no name for a session the index lacks', async () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'session_index.jsonl'),
    [
      '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
      '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
      '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
    ].join('\n'),
  );

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'), undefined, ctx.dir);

  const name = await adapter.loadName('c-missing', 'auto');

  expect(name).toBeNull();
});

test('it resumes when no transcript was reported', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.canResume({})).toBeTrue();
});

test('it resumes when the reported rollout exists', () => {
  using ctx = setupTest();

  const rollout = join(ctx.dir, 'rollout.jsonl');

  writeFileSync(rollout, '');

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.canResume({ transcriptSource: rollout })).toBeTrue();
});

test('it does not resume when the reported rollout is gone', () => {
  using ctx = setupTest();

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.canResume({ transcriptSource: join(ctx.dir, 'missing.jsonl') })).toBeFalse();
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: null, tool_name: 7 },
  });

  expect(ev).toStrictEqual({
    kind: 'needs-input',
    message: 'waiting for approval',
    detail: 'waiting for approval',
  });
});

test('it builds a codex resume command with a captured id', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.buildResumeCommand("/tmp/it's", toAgentSessionID('c-1'))).toBe(
    String.raw`cd '/tmp/it'\''s' && codex resume c-1`,
  );
});

test('it builds a codex resume command with the picker when no id was captured', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.buildResumeCommand('/tmp', undefined)).toBe(`cd '/tmp' && codex resume`);
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
  });

  expect(ev).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    detail: `${'x'.repeat(599)}…`,
    result: 'x'.repeat(700),
  });
});

test('it refuses inbox messages', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.takesMessages).toBeFalse();
});

test('it selects the ChatGPT endpoint and its profiles for an entry with auth, without requiring the broker', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

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
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.findAuthSelection()).toBeNull();
});

test('it plans no guest spawn of its own for an entry without auth', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planGuestSpawn).toBeUndefined();
});

test('it plans a remote spawn with auth but without the broker as a local spawn with no files', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: false },
    {
      atc: null,
      dir: '/tmp/atc/sessions/s1',
    },
  );

  expect(plan).toStrictEqual({ bin: 'codex', args: ['go'], files: {} });
});

test('it plans a spawn behind the broker with a Codex home of its own and hooks it trusts at launch', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: toAgentSessionID('c-1') },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
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
              'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InNvbWVvbmVAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiNWYwYzFkN2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDBjMGRlIn19.aW1wLWJyb2tlci1wbGFjZWhvbGRlcg',
            access_token: 'imp-broker-placeholder',
            refresh_token: 'imp-broker-placeholder',
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
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: false },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
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
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
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
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InNvbWVvbmVAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiNWYwYzFkN2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDBjMGRlIn19.aW1wLWJyb2tlci1wbGFjZWhvbGRlcg',
      access_token: 'imp-broker-placeholder',
      refresh_token: 'imp-broker-placeholder',
      account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
    },
    last_refresh: '2099-01-01T00:00:00Z',
  });
});

test('it reports every hook through the atc inside the host', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
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
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: null,
      dir: '/tmp/atc/sessions/s1',
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
    const config = parseConfig({
      authProfiles: {
        codex: {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        },
        github: { secret: 'github-imp-agents', kind: 'github' },
      },
      agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
    });

    const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

    const plan = () =>
      adapter.planGuestSpawn?.(
        { prompt: '', resume: false },
        {
          atc: '/opt/atc',
          dir: '/tmp/atc/sessions/s1',
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
        message: `agent 'codex' signs in through codex-chatgpt, whose sign-in in impd is ${status}; sign Codex in again and run imp secret add codex-chatgpt --kind oauth ... --replace with the new refresh token`,
        data: { agent: 'codex', secret: 'codex-chatgpt', status },
      }),
    );
  },
);

test('it refuses a spawn whose sign-in impd does not list', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = () =>
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: {}, profileEnv: {}, oauth: {} },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_signin_needed',
      message:
        "agent 'codex' signs in through codex-chatgpt, whose sign-in in impd is not listed; sign Codex in again and run imp secret add codex-chatgpt --kind oauth ... --replace with the new refresh token",
      data: { agent: 'codex', secret: 'codex-chatgpt', status: null },
    }),
  );
});

test.each([
  [null],
  [{ email: 'someone@example.com' }],
  [{ 'https://api.openai.com/auth': { chatgpt_account_id: '' } }],
])('it refuses a spawn whose ID token claims are %p', (idClaims) => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  const plan = () =>
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc',
        dir: '/tmp/atc/sessions/s1',
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
        "agent 'codex' signs in through codex-chatgpt, whose ID token in impd holds no ChatGPT account id; sign Codex in again and run imp secret add codex-chatgpt --kind oauth ... --replace with the new refresh token",
      data: { agent: 'codex', secret: 'codex-chatgpt', status: 'ready' },
    }),
  );
});

test('it seeds clone trust for an entry with auth', () => {
  const config = parseConfig({
    authProfiles: {
      codex: {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        host: 'chatgpt.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      github: { secret: 'github-imp-agents', kind: 'github' },
    },
    agents: { codex: { auth: { profiles: ['codex', 'github'] } } },
  });

  const adapter = new CodexAdapter(getAgentEntry(config, 'codex'), config);

  expect(adapter.planGuestWorkspaceTrust('/work')).toStrictEqual({
    'codex-trust.toml': '\n[projects."/work"]\ntrust_level = "trusted"\n',
  });
});

test('it seeds no clone trust for an entry without auth', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planGuestWorkspaceTrust('/work')).toBeNull();
});
