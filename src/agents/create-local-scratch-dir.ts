import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../shared/config';
import type { SessionID } from '../shared/session-id';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

/**
 * Creates the scratch folder of a session on the daemon's machine, under
 * the session's own folder in atc's state folder `dir`, readable by its
 * owner alone, and returns its path. A folder an earlier launch created
 * stays as it is.
 */
export function createLocalScratchDir(session: SessionID, dir: string = stateDir): string {
  const path = join(dir, 'sessions', session, SESSION_SCRATCH_FOLDER);

  mkdirSync(path, { recursive: true, mode: 0o700 });

  return path;
}
