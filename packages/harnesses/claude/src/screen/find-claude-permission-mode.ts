import { isRecord } from '@atc/core';
import { findFlagValue } from '@atc/plugin-api';

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
