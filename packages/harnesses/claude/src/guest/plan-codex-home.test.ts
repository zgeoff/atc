import { expect, test } from 'bun:test';
import type { AuthProfile } from '@atc/plugin-api';
import { buildMockAuthProfile } from '@atc/test-utils';
import { planCodexHome } from './plan-codex-home';

test('it plans a Codex home whose config sends log records to the telemetry host', () => {
  const plan = planCodexHome({
    authProfiles: new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    selected: ['codex'],
    guestDir: '/work/sessions/s1',
    revisionFolder: 'auth-r4',
    states: {
      'codex-chatgpt': {
        status: 'ready',
        idClaims: {
          'https://api.openai.com/auth': {
            chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
          },
        },
      },
    },
    telemetryHost: 'records.example.com',
  });

  expect({
    env: plan.env,
    unsetEnv: plan.unsetEnv,
    paths: Object.keys(plan.files),
    config: plan.files['auth-r4/codex-home/config.toml'],
  }).toStrictEqual({
    env: { CODEX_HOME: '/work/sessions/s1/auth-r4/codex-home' },
    unsetEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
    paths: ['auth-r4/codex-home/auth.json', 'auth-r4/codex-home/config.toml'],
    config: [
      'cli_auth_credentials_store = "file"',
      'check_for_update_on_startup = false',
      '',
      '[otel]',
      'log_user_prompt = false',
      'exporter = { otlp-http = { endpoint = "https://records.example.com/v1/logs", protocol = "json" } }',
      '',
    ].join('\n'),
  });
});

test('it plans a Codex home with the two fixed settings alone for a session with no telemetry host', () => {
  const plan = planCodexHome({
    authProfiles: new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    selected: ['codex'],
    guestDir: '/work/sessions/s1',
    revisionFolder: 'auth-r4',
    states: {
      'codex-chatgpt': {
        status: 'ready',
        idClaims: {
          'https://api.openai.com/auth': {
            chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
          },
        },
      },
    },
    telemetryHost: null,
  });

  expect(plan.files['auth-r4/codex-home/config.toml']).toBe(
    'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
  );
});

test('it plans no Codex home for a telemetry host when the ChatGPT sign-in is not ready', () => {
  const plan = planCodexHome({
    authProfiles: new Map<string, AuthProfile>([
      [
        'codex',
        buildMockAuthProfile({
          name: 'codex',
          secret: 'codex-chatgpt',
          kind: 'oauth',
          host: 'chatgpt.com',
          header: 'authorization',
          scheme: 'bearer',
        }),
      ],
    ]),
    selected: ['codex'],
    guestDir: '/work/sessions/s1',
    revisionFolder: 'auth-r4',
    states: { 'codex-chatgpt': { status: 'needs_login', idClaims: null } },
    telemetryHost: 'records.example.com',
  });

  expect(plan).toStrictEqual({ files: {}, env: {}, unsetEnv: [] });
});
