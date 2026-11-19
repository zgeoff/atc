import { isAbsolute } from 'node:path';
import { CONTROL_CHARACTER } from '@atc/protocol';

// The longest path Linux takes.
const MAX_PATH_LENGTH = 4096;

// A .. segment after a symlink names one folder on disk and another in a
// reading of the text, and Claude Code may read either way, so a plugin
// folder holds none.
export function findPluginDirProblem(directory: string): string | null {
  if (directory === '' || directory.length > MAX_PATH_LENGTH || CONTROL_CHARACTER.test(directory)) {
    return `each pluginDirs entry must be 1 to ${MAX_PATH_LENGTH} characters without control characters`;
  }

  if (
    (!isAbsolute(directory) && !directory.startsWith('~/')) ||
    directory.split('/').includes('..')
  ) {
    return `pluginDirs entry '${directory}' must be an absolute path or start with ~/, without a .. segment`;
  }

  return null;
}
