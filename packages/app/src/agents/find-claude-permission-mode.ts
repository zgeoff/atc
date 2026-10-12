import { isRecord } from '../shared/report';
import { findFlagValue } from './find-flag-value';

/**
 * The permission mode a Claude CLI agent's configuration sets: an explicit
 * `--permission-mode` in its arguments, else the `permissions.defaultMode`
 * its settings hold, or null when neither sets one. The argument wins, as it
 * does for the CLI itself.
 */
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
