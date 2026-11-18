import { expect, test } from 'bun:test';
import { buildCodexConfig } from './build-codex-config';

test('it builds the two fixed settings alone for a session with no telemetry host', () => {
  expect(buildCodexConfig(null)).toBe(
    'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n',
  );
});

test('it adds a log exporter to the telemetry host that leaves the prompt out', () => {
  expect(Bun.TOML.parse(buildCodexConfig('records.example.com'))).toStrictEqual({
    cli_auth_credentials_store: 'file',
    check_for_update_on_startup: false,
    otel: {
      log_user_prompt: false,
      exporter: {
        'otlp-http': { endpoint: 'https://records.example.com/v1/logs', protocol: 'json' },
      },
    },
  });
});

test('it keeps the log exporter apart from a table appended after it', () => {
  const config = `${buildCodexConfig('records.example.com')}\n[projects."/work/clone"]\ntrust_level = "trusted"\n`;

  expect(Bun.TOML.parse(config)).toMatchObject({
    otel: { log_user_prompt: false },
    projects: { '/work/clone': { trust_level: 'trusted' } },
  });
});
