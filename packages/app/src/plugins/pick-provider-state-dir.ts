import { join } from 'node:path';

// The folder a target's provider keeps its own files in, or null for a target id that would name
// a place outside the providers folder.
export function pickProviderStateDir(stateDir: string, targetID: string): string | null {
  if (targetID === '.' || targetID === '..' || /[/\\\0]/u.test(targetID)) {
    return null;
  }

  return join(stateDir, 'providers', targetID);
}
