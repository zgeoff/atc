import { readFileSync } from 'node:fs';

/**
 * The pid a daemon's pid file holds, or null when the file is missing or
 * holds anything but a pid above 1.
 */
export function findPidFilePID(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));

    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
