// The OTLP exporter appends the signal's path (such as /v1/logs) to this endpoint,
// so the endpoint carries only the host.
export function buildTelemetryEnv(host: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `https://${host}`,
  };
}
