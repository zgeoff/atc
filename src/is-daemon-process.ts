import { readFileSync } from 'node:fs';
import { isDaemonCommandLine } from './is-daemon-command-line';

/**
 * Whether the process with this pid runs `atc daemon`, judged by its command
 * line. A pid that cannot be read is not verified, so it reads as false: a
 * recorded pid may have been reused by an unrelated process since the daemon
 * died.
 */
export function isDaemonProcess(pid: number): boolean {
  let cmdline: string;

  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false;
  }

  return isDaemonCommandLine(cmdline.split('\0').filter((arg) => arg !== ''));
}
