import { toShellArg } from '@atc/core';

export function formatAgentEnvFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}=${toShellArg(value)}\n`)
    .join('');
}
