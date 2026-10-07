import { readFileSync } from 'node:fs';

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

  const args = cmdline.split('\0').filter((arg) => arg !== '');
  const at = args.indexOf('daemon', 1);

  return at > 0 && (args[at + 1] === undefined || args[at + 1]?.startsWith('--') === true);
}
