// The variables that make Claude Code send its log records to a host as OTLP
// over HTTP with JSON bodies. Claude Code adds the signal's path to the endpoint.
export function buildTelemetryEnv(host: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `https://${host}`,
  };
}
