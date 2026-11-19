import { join } from 'node:path';

export function pickProviderStateDir(stateDir: string, targetID: string): string | null {
  if (targetID === '.' || targetID === '..' || /[/\\\0]/u.test(targetID)) {
    return null;
  }

  return join(stateDir, 'providers', targetID);
}
