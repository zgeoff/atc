import { collectRestartEnv } from '../restart/collect-restart-env';
import type { DaemonProcess } from './types';

export function readOwnDaemonProcess(): DaemonProcess {
  return {
    env: collectRestartEnv(process.env),
    cwd: null,
    flags: { listen: null, tokenFile: null },
    fromProc: false,
  };
}
