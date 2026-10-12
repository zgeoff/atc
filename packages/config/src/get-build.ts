import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The version to stamp, and the source trees whose newest file stamps it.
interface BuildSource {
  readonly version: string;
  readonly roots: readonly string[];
}

/**
 * The build identity used in the protocol handshake. The version alone
 * never changes between pulls, so the newest mtime across the source trees
 * (or the compiled binary's, when no tree can be read) is folded in — a
 * client and daemon from different checkouts of the same version still read
 * as different builds, which is what triggers the stale-daemon restart. Any
 * source file counts: a stamp taken from a single file misses every change
 * that lands elsewhere and leaves stale daemons in service.
 */
export function getBuild(source: BuildSource): string {
  let stamp = 0;

  for (const root of source.roots) {
    try {
      stamp = Math.max(stamp, getNewestTSMtime(root));
    } catch {}
  }

  if (stamp === 0) {
    try {
      stamp = statSync(process.execPath).mtimeMs;
    } catch {}
  }

  return `atc/${source.version}+${Math.round(stamp).toString(36)}`;
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
