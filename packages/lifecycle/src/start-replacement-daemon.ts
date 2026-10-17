import type { DaemonProcess } from './daemon-process';
import { spawnATCDetached } from './spawn-atc-detached';

interface ReplacementOverrides {
  readonly listen: string | null;
  readonly tokenFile: string | null;
}

export function startReplacementDaemon(
  atcArgv: readonly string[],
  old: DaemonProcess,
  overrides: ReplacementOverrides,
): number | undefined {
  const listen = overrides.listen ?? old.flags.listen;
  const tokenFile = overrides.tokenFile ?? old.flags.tokenFile;

  const child = spawnATCDetached(
    atcArgv,
    [
      'daemon',
      ...(listen === null ? [] : ['--listen', listen]),
      ...(tokenFile === null ? [] : ['--token-file', tokenFile]),
    ],
    { env: old.env, ...(old.cwd === null ? {} : { cwd: old.cwd }) },
  );

  return child.pid;
}
