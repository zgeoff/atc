// Codex reads its log exporter from this file alone, never from the environment.
export function buildCodexConfig(telemetryHost: string | null): string {
  return [
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    ...(telemetryHost === null ? [] : buildTelemetryLines(telemetryHost)),
    '',
  ].join('\n');
}

function buildTelemetryLines(host: string): string[] {
  return [
    '',
    '[otel]',
    'log_user_prompt = false',
    `exporter = { otlp-http = { endpoint = "https://${host}/v1/logs", protocol = "json" } }`,
  ];
}
