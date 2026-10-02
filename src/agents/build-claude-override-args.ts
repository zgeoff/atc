import type { SpawnOverrides } from './agent-adapter';
import { buildArgsWithoutFlags } from './build-args-without-flags';

/**
 * The configured leading arguments for a Claude CLI spawn with the session's
 * model and effort applied. An override replaces any `--model` or `--effort`
 * the configured arguments carry, value included, so the session never
 * depends on which occurrence the CLI honours. Without overrides the
 * configured arguments pass through unchanged. Each value travels as its own
 * argument, never through a shell.
 */
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
