import { userInfo } from 'node:os';
import { resolveStateDir } from '@atc/config/host';
import { isDaemonCommandLine } from './is-daemon-command-line';
import { readProcProcess } from './read-proc-process';

export function probeDaemonProcess(pid: number, stateDir: string, procRoot: string): boolean {
  const proc = readProcProcess(procRoot, pid);

  // an unreadable entry is not verified: a recorded pid may have been reused
  // by an unrelated process since the daemon died.
  if (proc === null || !isDaemonCommandLine(proc.args)) {
    return false;
  }

  // An empty or missing HOME makes the daemon fall back to the account's
  // home, as `os.homedir()` does.
  const home = proc.env['HOME'];
  const daemonHome = home === undefined || home === '' ? userInfo().homedir : home;

  return resolveStateDir(daemonHome) === stateDir;
}
