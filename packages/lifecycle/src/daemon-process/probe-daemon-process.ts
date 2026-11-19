import { userInfo } from 'node:os';
import { resolveStateDir } from '@atcx/contract/light';
import { isDaemonCommandLine } from './is-daemon-command-line';
import { readProcProcess } from './read-proc-process';

export function probeDaemonProcess(pid: number, stateDir: string, procRoot: string): boolean {
  const subprocess = readProcProcess(procRoot, pid);

  if (subprocess === null || !isDaemonCommandLine(subprocess.args)) {
    return false;
  }

  const home = subprocess.env['HOME'];
  const daemonHome = home === undefined || home === '' ? userInfo().homedir : home;

  return resolveStateDir(daemonHome) === stateDir;
}
