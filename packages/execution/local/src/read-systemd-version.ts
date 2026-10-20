import { readFileSync } from 'node:fs';

// Every systemd program links the libsystemd-shared library of its own
// release, so the file names the release without running the program.
export function readSystemdVersion(path: string): number | null {
  let bytes: string;

  try {
    bytes = readFileSync(path, 'latin1');
  } catch {
    return null;
  }

  const release = /libsystemd-shared-(?<release>\d+)/u.exec(bytes)?.groups?.['release'];

  return release === undefined ? null : Number(release);
}
