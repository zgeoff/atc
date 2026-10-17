import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from '@atc/config';
import { buildATCBridgeFiles } from './build-atc-bridge-files';

// the folder is never cleared, since Claude Code keeps its own type files there
export function writeATCBridge(
  argv: readonly string[],
  dir: string = join(stateDir, 'atc-bridge'),
): string {
  const files = buildATCBridgeFiles(argv);

  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);

    // any write reloads the mod in every running session
    if (tryReadFileText(file) === content) {
      continue;
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  return dir;
}

function tryReadFileText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
