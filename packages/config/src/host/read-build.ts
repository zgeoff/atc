import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The version to stamp, and the source trees whose newest file stamps it.
interface BuildSource {
  readonly version: string;
  readonly roots: readonly string[];
}

// the version alone never changes between pulls, so the newest mtime across
// every source file is folded in; a stamp from one file misses changes that
// land elsewhere and leaves stale daemons in service.
export function readBuild(source: BuildSource): string {
  let stamp = 0;

  for (const root of source.roots) {
    try {
      stamp = Math.max(stamp, readNewestTSMtime(root));
    } catch {}
  }

  if (stamp === 0) {
    try {
      stamp = statSync(process.execPath).mtimeMs;
    } catch {}
  }

  return `atc/${source.version}+${Math.round(stamp).toString(36)}`;
}

function readNewestTSMtime(dir: string): number {
  let stamp = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      stamp = Math.max(stamp, readNewestTSMtime(entryPath));
    } else if (entry.name.endsWith('.ts')) {
      stamp = Math.max(stamp, statSync(entryPath).mtimeMs);
    }
  }

  return stamp;
}
