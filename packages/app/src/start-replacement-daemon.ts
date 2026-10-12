import type { DaemonProcess } from './daemon-process';
import { spawnATCDetached } from './shared/spawn-atc-detached';

interface ReplacementOverrides {
  readonly listen: string | null;
  readonly tokenFile: string | null;
}

/**
 * Starts one daemon, detached, the way the one it replaces was started: its
 * environment, its working directory, and its `--listen` and `--token-file`
 * values, except where `overrides` sets them.
 */
export function startReplacementDaemon(
  old: DaemonProcess,
  overrides: ReplacementOverrides,
): number | undefined {
  const listen = overrides.listen ?? old.flags.listen;
  const tokenFile = overrides.tokenFile ?? old.flags.tokenFile;

  const child = spawnATCDetached(
    [
      'daemon',
      ...(listen === null ? [] : ['--listen', listen]),
      ...(tokenFile === null ? [] : ['--token-file', tokenFile]),
    ],
    { env: old.env, ...(old.cwd === null ? {} : { cwd: old.cwd }) },
  );

  return child.pid;
}
