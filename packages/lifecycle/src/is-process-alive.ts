import { readFileSync } from 'node:fs';

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

    // a zombie has exited, unless other threads still run and hold its files
    // and sockets open.
    return fields[0] !== 'Z' || Number(fields[17]) > 1;
  } catch {
    return true;
  }
}
