import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface DaemonRecord {
  // the id of the daemon that last readied a host, or null before any did
  readonly read: () => string | null;
  readonly write: (daemonID: string) => void;
}

// Keeps the daemon's id in the provider's state folder, so a forget or a sleep after a restart
// still tells its own objects from another daemon's. The id is the one every object's
// `atc.daemon` label holds.
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
