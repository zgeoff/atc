import type { SpawnOverrides } from '@atc/plugin-api';
import { buildArgsWithoutFlags } from '@atc/plugin-api';

export function buildClaudeOverrideArgs(
  configured: readonly string[],
  overrides: SpawnOverrides,
): string[] {
  const replaced = [
    ...(overrides.model === undefined ? [] : ['--model']),
    ...(overrides.effort === undefined ? [] : ['--effort']),
  ];

  return [
    ...buildArgsWithoutFlags(configured, replaced),
    ...(overrides.model === undefined ? [] : ['--model', overrides.model]),
    ...(overrides.effort === undefined ? [] : ['--effort', overrides.effort]),
  ];
}
