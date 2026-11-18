import { buildTelemetryEnv } from './build-telemetry-env';

interface TelemetryOwner {
  readonly profile: string;
  readonly host: string;
}

export function collectTelemetryEnvProblems(
  sources: readonly (readonly [string, readonly string[]])[],
  telemetry: TelemetryOwner | null,
): string[] {
  if (telemetry === null) {
    return [];
  }

  const variables = Object.keys(buildTelemetryEnv(telemetry.host));

  return sources.flatMap(([source, keys]) =>
    keys
      .filter((key) => variables.includes(key))
      .map(
        (key) =>
          `${source} sets ${key}, which the telemetry of auth profile ${telemetry.profile} sets`,
      ),
  );
}
