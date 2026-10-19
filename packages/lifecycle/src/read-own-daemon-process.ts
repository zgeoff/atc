import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';

export function readOwnDaemonProcess(): DaemonProcess {
  return {
    env: collectRestartEnv(process.env),
    cwd: null,
    flags: { listen: null, tokenFile: null },
    fromProc: false,
  };
}
