import { isRecord } from '@atc/core';
import { findFlagValue } from '@atc/plugin-api';

// the argument wins over the settings, as it does for the CLI itself
export function findClaudePermissionMode(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string | null {
  const flag = findFlagValue(args, ['--permission-mode']);

  if (flag !== null) {
    return flag;
  }

  const permissions = settings?.['permissions'];
  const defaultMode = isRecord(permissions) ? permissions['defaultMode'] : undefined;

  return typeof defaultMode === 'string' && defaultMode !== '' ? defaultMode : null;
}
