import { expect, test } from 'bun:test';
import { collectTelemetryEnvProblems } from './collect-telemetry-env-problems';

test('it reports each source variable that the telemetry of a profile sets', () => {
  expect(
    collectTelemetryEnvProblems(
      [
        ['env', ['OTEL_LOGS_EXPORTER', 'EDITOR']],
        ['settings.env', ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_PROTOCOL']],
      ],
      { profile: 'records', host: 'records.example.com' },
    ),
  ).toStrictEqual([
    'env sets OTEL_LOGS_EXPORTER, which the telemetry of auth profile records sets',
    'settings.env sets CLAUDE_CODE_ENABLE_TELEMETRY, which the telemetry of auth profile records sets',
    'settings.env sets OTEL_EXPORTER_OTLP_PROTOCOL, which the telemetry of auth profile records sets',
  ]);
});

test('it reports nothing when no profile turns telemetry on', () => {
  expect(
    collectTelemetryEnvProblems(
      [['env', ['OTEL_LOGS_EXPORTER', 'OTEL_EXPORTER_OTLP_ENDPOINT']]],
      null,
    ),
  ).toStrictEqual([]);
});
