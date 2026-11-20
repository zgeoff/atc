import { readFile } from 'node:fs/promises';

interface DaemonSocketLocation {
  readonly daemonSocketPath: string;
  readonly daemonRecordFile: string;
}

// The socket paths to try, in order: the computed path, then the path the daemon record holds when
// it differs, since a client whose environment lacks XDG_RUNTIME_DIR computes another path than the
// daemon's. A missing or unreadable record counts as none.
export async function readDaemonSocketPaths(paths: DaemonSocketLocation): Promise<string[]> {
  let recorded: string | null = null;

  try {
    // loaded on demand: a process that only needs a path never pays for the contract's schemas
    const contract = await import('@atcx/contract');
    const text = await readFile(paths.daemonRecordFile, 'utf8');

    const parsed = contract.DAEMON_RECORD_SOCKET_SCHEMA.safeParse(JSON.parse(text));

    recorded = parsed.success ? parsed.data.socketPath : null;
  } catch {
    recorded = null;
  }

  return recorded === null || recorded === paths.daemonSocketPath
    ? [paths.daemonSocketPath]
    : [paths.daemonSocketPath, recorded];
}
