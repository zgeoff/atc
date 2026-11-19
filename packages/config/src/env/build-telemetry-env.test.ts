import { expect, test } from 'bun:test';
import { buildTelemetryEnv } from './build-telemetry-env';

test('it builds the variables that send Claude Code log records to the host as OTLP JSON', () => {
  expect(buildTelemetryEnv('records.example.com')).toStrictEqual({
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://records.example.com',
  });
});
