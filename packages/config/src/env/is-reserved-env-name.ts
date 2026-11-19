import { isBrokerVariable, isSubscriptionOverrideVariable } from '@atc/core';

const RESERVED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'ATC_', 'CODEX_', 'OPENAI_'];

const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set(['PATH', 'HOME']);

export function isReservedEnvName(key: string): boolean {
  return (
    isBrokerVariable(key) ||
    isSubscriptionOverrideVariable(key) ||
    RESERVED_ENV_NAMES.has(key) ||
    RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
