import { chmodSync, mkdirSync } from 'node:fs';
import { pickProviderStateDir } from './pick-provider-state-dir';

export function createProviderStateDir(stateDir: string, targetID: string): string | null {
  const folder = pickProviderStateDir(stateDir, targetID);

  if (folder === null) {
    return null;
  }

  mkdirSync(folder, { recursive: true, mode: 0o700 });

  // mkdir's mode is cut by the umask, and leaves a folder that already exists as it was
  chmodSync(folder, 0o700);

  return folder;
}
