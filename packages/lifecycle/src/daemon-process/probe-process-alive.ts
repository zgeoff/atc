import { readFileSync } from 'node:fs';

export function probeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

    // A zombie whose other threads still run is alive: they keep its files and sockets open.
    return fields[0] !== 'Z' || Number(fields[17]) > 1;
  } catch {
    return true;
  }
}
