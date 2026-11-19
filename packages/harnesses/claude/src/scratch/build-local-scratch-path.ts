import { join } from 'node:path';
import { stateDir } from '@atc/config';
import type { SessionID } from '@atcx/contract';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

export function buildLocalScratchPath(session: SessionID, directory: string = stateDir): string {
  return join(directory, 'sessions', session, SESSION_SCRATCH_FOLDER);
}
