import { userInfo } from 'node:os';
import { resolveStateDir } from '@atc/config/host';
import { isDaemonCommandLine } from './is-daemon-command-line';
import { readProcProcess } from './read-proc-process';

/**
 * Whether the process with this pid runs `atc daemon` on this state
 * directory: its command line starts the daemon, and the home in its
 * environment puts its state directory at `stateDir`. A daemon of another
 * checkout or another test home is not this one. A pid whose entry under
 * `procRoot` cannot be read is not verified, so it reads as false: a
 * recorded pid may have been reused by an unrelated process since the
 * daemon died.
 */
export function isDaemonProcess(pid: number, stateDir: string, procRoot: string): boolean {
  const proc = readProcProcess(procRoot, pid);

  if (proc === null || !isDaemonCommandLine(proc.args)) {
    return false;
  }

  // An empty or missing HOME makes the daemon fall back to the account's
  // home, as `os.homedir()` does.
  const home = proc.env['HOME'];
  const daemonHome = home === undefined || home === '' ? userInfo().homedir : home;

  return resolveStateDir(daemonHome) === stateDir;
}
