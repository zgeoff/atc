import { readFileSync } from 'node:fs';

/**
 * The systemd release a systemd program at `path` belongs to, or null when
 * the file cannot be read or holds no release. Every systemd program links
 * the `libsystemd-shared-<release>` library of its own release, so the
 * library's name in the file holds the release, read without running the
 * program.
 */
export function findSystemdVersion(path: string): number | null {
  let bytes: string;

  try {
    bytes = readFileSync(path, 'latin1');
  } catch {
    return null;
  }

  const release = /libsystemd-shared-(?<release>\d+)/u.exec(bytes)?.groups?.['release'];

  return release === undefined ? null : Number(release);
}
