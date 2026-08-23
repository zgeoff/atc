import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json';

// The src/ root, so the walk covers every module under it.
const SRC_ROOT = join(import.meta.dir, '..');

/**
 * The build identity used in the protocol handshake. The version alone
 * never changes between pulls, so the newest mtime across the source tree
 * (or the compiled binary's) is folded in — a client and daemon from
 * different checkouts of the same version still read as different builds,
 * which is what triggers the stale-daemon restart. Any source file counts:
 * a stamp taken from a single file misses every change that lands
 * elsewhere and leaves stale daemons in service.
 */
export function getBuild(): string {
  let stamp = 0;

  try {
    stamp = getNewestTSMtime(SRC_ROOT);
  } catch {}

  if (stamp === 0) {
    try {
      stamp = statSync(process.execPath).mtimeMs;
    } catch {}
  }

  return `atc/${pkg.version}+${Math.round(stamp).toString(36)}`;
}

function getNewestTSMtime(dir: string): number {
  let stamp = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      stamp = Math.max(stamp, getNewestTSMtime(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      stamp = Math.max(stamp, statSync(entryPath).mtimeMs);
    }
  }

  return stamp;
}
