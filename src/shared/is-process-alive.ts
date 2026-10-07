import { readFileSync } from 'node:fs';

/**
 * Whether a process with this pid is running. A zombie awaiting its parent's
 * wait call has exited, so it reads as not running where `/proc` shows it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');

    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return true;
  }
}
