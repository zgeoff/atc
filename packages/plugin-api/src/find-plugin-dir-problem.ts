import { isAbsolute } from 'node:path';
import { CONTROL_CHARACTER } from '@atc/protocol';

// The longest path Linux takes.
const MAX_PATH_LENGTH = 4096;

// A .. segment after a symlink names one folder on disk and another in a
// reading of the text, and Claude Code may read either way, so a plugin
// folder holds none.
export function findPluginDirProblem(dir: string): string | null {
  if (dir === '' || dir.length > MAX_PATH_LENGTH || CONTROL_CHARACTER.test(dir)) {
    return `each pluginDirs entry must be 1 to ${MAX_PATH_LENGTH} characters without control characters`;
  }

  if ((!isAbsolute(dir) && !dir.startsWith('~/')) || dir.split('/').includes('..')) {
    return `pluginDirs entry '${dir}' must be an absolute path or start with ~/, without a .. segment`;
  }

  return null;
}
