import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionID } from '@atc/core/session-id';
import { stateDir } from '../shared/config';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

/**
 * Creates the scratch folder of a session on the daemon's machine, under
 * the session's own folder in atc's state folder `dir`, readable by its
 * owner alone, and returns its path. A folder an earlier launch created
 * keeps its contents and takes that mode again.
 */
export function createLocalScratchDir(session: SessionID, dir: string = stateDir): string {
  const path = join(dir, 'sessions', session, SESSION_SCRATCH_FOLDER);

  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);

  return path;
}
