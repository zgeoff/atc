import { isRecord } from '../shared/report';
import { findFlagValue } from './find-flag-value';

/**
 * The permission mode a Claude CLI agent starts its sessions in: an explicit
 * `--permission-mode` in its configured arguments, else the
 * `permissions.defaultMode` its configured settings hold, else auto, the
 * mode a headless turn falls back to because no human is at a terminal to
 * answer a prompt. The argument wins, as it does for the CLI itself.
 */
export function resolveClaudePermissionMode(
  args: readonly string[],
  settings: Readonly<Record<string, unknown>> | undefined,
): string {
  const flag = findFlagValue(args, ['--permission-mode']);

  if (flag !== null) {
    return flag;
  }

  const permissions = settings?.['permissions'];
  const defaultMode = isRecord(permissions) ? permissions['defaultMode'] : undefined;

  return typeof defaultMode === 'string' && defaultMode !== '' ? defaultMode : 'auto';
}
