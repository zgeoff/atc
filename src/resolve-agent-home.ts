import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * An agent CLI's home directory: the named environment variable when it is
 * set and non-empty, otherwise the given default directory under the user's
 * home.
 */
export function resolveAgentHome(envVar: string, defaultDirName: string): string {
  const home = process.env[envVar];

  return home !== undefined && home !== '' ? home : join(homedir(), defaultDirName);
}
