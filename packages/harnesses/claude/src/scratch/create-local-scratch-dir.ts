import { chmodSync, mkdirSync } from 'node:fs';
import { stateDir } from '@atc/config';
import type { SessionID } from '@atcx/contract';
import { buildLocalScratchPath } from './build-local-scratch-path';

export function createLocalScratchDir(session: SessionID, directory: string = stateDir): string {
  const path = buildLocalScratchPath(session, directory);

  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);

  return path;
}
