import { readFileSync } from 'node:fs';

export function findPidFilePID(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));

    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
