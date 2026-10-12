import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';

/**
 * The start a daemon gets when no running one supplies it: this process's
 * environment without the session variables, no working directory, and no
 * listener flags.
 */
export function buildOwnDaemonProcess(): DaemonProcess {
  return {
    env: collectRestartEnv(process.env),
    cwd: null,
    flags: { listen: null, tokenFile: null },
    fromProc: false,
  };
}
