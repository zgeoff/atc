import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { isDaemonCommandLine } from './is-daemon-command-line';

/**
 * Whether the process with this pid runs `atc daemon` on this state
 * directory: its command line starts the daemon, and the home in its
 * environment puts its state directory at `stateDir`. A daemon of another
 * checkout or another test home is not this one. A pid that cannot be read
 * is not verified, so it reads as false: a recorded pid may have been reused
 * by an unrelated process since the daemon died.
 */
export function isDaemonProcess(pid: number, stateDir: string): boolean {
  let cmdline: string;
  let environ: string;

  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return false;
  }

  if (!isDaemonCommandLine(cmdline.split('\0').filter((arg) => arg !== ''))) {
    return false;
  }

  const homeVar = environ.split('\0').find((entry) => entry.startsWith('HOME='));
  const home = homeVar === undefined || homeVar === 'HOME=' ? userInfo().homedir : homeVar.slice(5);

  return join(home, '.local', 'state', 'atc') === stateDir;
}
