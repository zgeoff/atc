import { readFileSync } from 'node:fs';

/**
 * Whether a process with this pid is running. A zombie awaiting its parent's
 * wait call has exited, so it reads as not running where `/proc` shows it.
 * A zombie whose thread count is above one has not: its main thread is gone,
 * but its other threads still run and still hold its files and sockets open,
 * so it reads as running until they exit too.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');

    // The fields after the command name, from field 3 (the state) on, so
    // field 20 (the thread count) sits at index 17.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

    return fields[0] !== 'Z' || Number(fields[17]) > 1;
  } catch {
    return true;
  }
}
