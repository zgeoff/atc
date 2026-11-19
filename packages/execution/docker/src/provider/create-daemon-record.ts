import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface DaemonRecord {
  readonly read: () => string | null;
  readonly write: (daemonID: string) => void;
}

// The id lives on disk because a forget or a sleep after a restart must still match the
// `atc.daemon` label on this daemon's objects and leave other daemons' objects alone.
export function createDaemonRecord(stateDir: string): DaemonRecord {
  const file = join(stateDir, 'daemon-id');
  let known: string | null = null;

  return {
    read: () => {
      if (known !== null) {
        return known;
      }

      try {
        known = readFileSync(file, 'utf8').trim() || null;
      } catch {
        known = null;
      }

      return known;
    },
    write: (daemonID) => {
      if (known === daemonID) {
        return;
      }

      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${daemonID}\n`, { mode: 0o600 });

      known = daemonID;
    },
  };
}
