import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentEntry } from '../../test/get-agent-entry';
import { updateEnv } from '../../test/update-env';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { CodexAdapter } from './codex-adapter';

function setupCodexHome(indexLines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-codex-'));

  updateEnv('CODEX_HOME', dir);
  writeFileSync(join(dir, 'session_index.jsonl'), indexLines.join('\n'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('it spawns fresh, picker-resume, and id-resume codex commands', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.planSpawn({ prompt: 'fix the bug', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['fix the bug'],
  });

  expect(adapter.planSpawn({ prompt: '', resume: true })).toStrictEqual({
    bin: 'codex',
    args: ['resume'],
  });

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

test('it maps codex prompt, stop, permission, and end events to session kinds', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const submitted = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { session_id: 'c-1', prompt: 'do the thing' },
  });

  expect(submitted).toMatchObject({ kind: 'prompt-submitted', message: 'do the thing' });

  const stopped = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'pong' },
  });

  expect(stopped).toMatchObject({ kind: 'turn-done', detail: 'pong' });

  const approval = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: 'c-1', tool_name: 'shell' },
  });

  expect(approval).toMatchObject({ kind: 'needs-input', message: 'waiting for approval: shell' });

  const ended = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionEnd',
    payload: { session_id: 'c-1', reason: 'other' },
  });

  expect(ended).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it loads the latest indexed thread name but never over a user-typed name', async () => {
  setupCodexHome([
    '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
    '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
    '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
  ]);

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const autoName = await adapter.loadName('c-1', 'auto');
  const userName = await adapter.loadName('c-1', 'user');
  const missingName = await adapter.loadName('c-missing', 'auto');

  expect(autoName).toStrictEqual({ name: 'renamed title' });
  expect(userName).toBeNull();
  expect(missingName).toBeNull();
});

test('it resumes when no transcript was reported or the reported rollout exists', () => {
  const dir = setupCodexHome([]);
  const rollout = join(dir, 'rollout.jsonl');

  writeFileSync(rollout, '');

  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: rollout })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
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

test('it builds codex resume commands with and without a captured id', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.buildResumeCommand("/tmp/it's", toAgentSessionID('c-1'))).toBe(
    String.raw`cd '/tmp/it'\''s' && codex resume c-1`,
  );

  expect(adapter.buildResumeCommand('/tmp', undefined)).toBe(`cd '/tmp' && codex resume`);
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
  });

  expect(ev).toMatchObject({ kind: 'turn-done', result: 'x'.repeat(700) });
  expect(ev.detail).toHaveLength(600);
});

test('it refuses inbox messages', () => {
  const adapter = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect(adapter.takesMessages).toBe(false);
});

const CODEX_AUTH_CONFIG = {
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
};

const ACCOUNT_ID = '5f0c1d7e-0000-4000-8000-00000000c0de';

const READY = {
  status: 'ready',
  idClaims: {
    email: 'someone@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
    sub: 'user-1',
  },
} as const;

function setupSignedInAdapter(): CodexAdapter {
  const config = parseConfig(CODEX_AUTH_CONFIG);

  return new CodexAdapter(getAgentEntry(config, 'codex'), config);
}

test('it selects the ChatGPT endpoint and its profiles for an entry with auth, without requiring the broker', () => {
  const adapter = setupSignedInAdapter();

  expect(adapter.findAuthSelection()).toStrictEqual({
    gateway: {
      id: 'codex',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      auth: { profiles: ['codex', 'github'], placeholderEnv: {} },
    },
    profiles: parseConfig(CODEX_AUTH_CONFIG).authProfiles,
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
  const adapter = setupSignedInAdapter();

  expect(
    adapter.planGuestSpawn?.(
      { prompt: 'go', resume: false },
      { atc: null, dir: '/tmp/atc/sessions/s1' },
    ),
  ).toStrictEqual({ bin: 'codex', args: ['go'], files: {} });
});

test('it plans a spawn behind the broker with a Codex home of its own and hooks it trusts at launch', () => {
  const adapter = setupSignedInAdapter();
  const dir = '/tmp/atc/sessions/s1';

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: toAgentSessionID('c-1') },
    {
      atc: '/opt/atc',
      dir,
      auth: { revision: 2, env: {}, profileEnv: {}, oauth: { 'codex-chatgpt': READY } },
    },
  );

  expect({
    bin: plan?.bin,
    args: plan?.args.slice(2),
    env: plan?.env,
    files: Object.keys(plan?.files ?? {}),
    config: plan?.files['auth-r2/config.toml'],
  }).toStrictEqual({
    bin: 'sh',
    args: [
      'sh',
      `${dir}/codex-home`,
      `${dir}/auth-r2`,
      `${dir}/codex-trust.toml`,
      'codex',
      '--dangerously-bypass-hook-trust',
      '-c',
      'cli_auth_credentials_store="file"',
      'resume',
      'c-1',
      'go',
    ],
    env: { CODEX_HOME: `${dir}/codex-home` },
    files: ['auth-r2/auth.json', 'auth-r2/config.toml', 'auth-r2/hooks.json'],
    config: 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
  });
});

test("it keeps its own Codex home over a profile's variables", () => {
  const adapter = setupSignedInAdapter();
  const dir = '/tmp/atc/sessions/s1';

  const plan = adapter.planGuestSpawn?.(
    { prompt: 'go', resume: false },
    {
      atc: '/opt/atc',
      dir,
      auth: {
        revision: 1,
        env: {},
        profileEnv: { CODEX_HOME: '/elsewhere', OP_CONNECT_HOST: 'https://op.example.com' },
        oauth: { 'codex-chatgpt': READY },
      },
    },
  );

  expect(plan?.env).toStrictEqual({
    CODEX_HOME: `${dir}/codex-home`,
    OP_CONNECT_HOST: 'https://op.example.com',
  });
});

test("it writes the sign-in file from the oauth secret's claims and account id", () => {
  const adapter = setupSignedInAdapter();

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: {}, profileEnv: {}, oauth: { 'codex-chatgpt': READY } },
    },
  );

  const file = plan?.files['auth-r1/auth.json'];
  const parsed: unknown = typeof file === 'string' ? JSON.parse(file) : file;

  expect(parsed).toMatchObject({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'imp-broker-placeholder', account_id: ACCOUNT_ID },
  });
});

test('it reports every hook through the atc inside the host', () => {
  const adapter = setupSignedInAdapter();

  const plan = adapter.planGuestSpawn?.(
    { prompt: '', resume: false },
    {
      atc: '/opt/atc',
      dir: '/tmp/atc/sessions/s1',
      auth: { revision: 1, env: {}, profileEnv: {}, oauth: { 'codex-chatgpt': READY } },
    },
  );

  const hooks = plan?.files['auth-r1/hooks.json'];
  const parsed: unknown = typeof hooks === 'string' ? JSON.parse(hooks) : hooks;

  expect(parsed).toMatchObject({
    hooks: {
      SessionStart: [{ hooks: [{ command: '"/opt/atc" hook-report --agent codex' }] }],
      UserPromptSubmit: [{ hooks: [{ command: '"/opt/atc" hook-report --agent codex' }] }],
      PermissionRequest: [{ hooks: [{ command: '"/opt/atc" hook-report --agent codex' }] }],
      Stop: [{ hooks: [{ command: '"/opt/atc" hook-report --agent codex' }] }],
      SessionEnd: [{ hooks: [{ command: '"/opt/atc" hook-report --agent codex', timeout: 3 }] }],
    },
  });
});

test('it plans no spawn behind the broker on a host without atc', () => {
  const adapter = setupSignedInAdapter();

  expect(
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: null,
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: {}, profileEnv: {}, oauth: { 'codex-chatgpt': READY } },
      },
    ),
  ).toBeNull();
});

test.each([
  ['needs_login', { 'codex-chatgpt': { ...READY, status: 'needs_login' } }, 'needs_login'],
  ['pending', { 'codex-chatgpt': { ...READY, status: 'pending' } }, 'pending'],
  ['not listed', {}, null],
] as const)('it refuses a spawn whose sign-in is %s', (shown, oauth, status) => {
  const adapter = setupSignedInAdapter();

  const plan = () =>
    adapter.planGuestSpawn?.(
      { prompt: '', resume: false },
      {
        atc: '/opt/atc',
        dir: '/tmp/atc/sessions/s1',
        auth: { revision: 1, env: {}, profileEnv: {}, oauth },
      },
    );

  expect(plan).toThrow(
    expect.objectContaining({
      code: 'auth_signin_needed',
      message: `agent 'codex' signs in through codex-chatgpt, whose sign-in in impd is ${shown}; sign Codex in again and run imp secret add codex-chatgpt --kind oauth ... --replace with the new refresh token`,
      data: { agent: 'codex', secret: 'codex-chatgpt', status },
    }),
  );
});

test.each([
  ['no claims', null],
  ['no OpenAI auth claim', { email: 'someone@example.com' }],
  ['an empty account id', { 'https://api.openai.com/auth': { chatgpt_account_id: '' } }],
])('it refuses a spawn whose ID token holds %s', (_name, idClaims) => {
  const adapter = setupSignedInAdapter();

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
    }),
  );
});

test('it seeds clone trust only for an entry with auth', () => {
  const signedIn = setupSignedInAdapter();

  const stock = new CodexAdapter(getAgentEntry(parseConfig({}), 'codex'));

  expect([
    signedIn.planGuestWorkspaceTrust('/work'),
    stock.planGuestWorkspaceTrust('/work'),
  ]).toStrictEqual([
    { 'codex-trust.toml': '\n[projects."/work"]\ntrust_level = "trusted"\n' },
    null,
  ]);
});
