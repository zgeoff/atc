import { toShellArg } from '@atc/core';

// A shell file that exports each variable of an agent entry's env, for a
// command outside atc to source.
export function formatAgentEnvFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${toShellArg(value)}\n`)
    .join('');
}
