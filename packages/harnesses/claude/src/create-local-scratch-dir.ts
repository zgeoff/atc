import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '@atc/config';
import type { SessionID } from '@atc/core';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

export function createLocalScratchDir(session: SessionID, directory: string = stateDir): string {
  const path = join(directory, 'sessions', session, SESSION_SCRATCH_FOLDER);

  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);

  return path;
}
