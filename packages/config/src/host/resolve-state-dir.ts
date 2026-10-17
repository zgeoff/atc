import { join } from 'node:path';

export function resolveStateDir(home: string): string {
  return join(home, '.local', 'state', 'atc');
}
