import { DaemonError } from '@atc/protocol/wire';
import type { DaemonClient } from '@atc/protocol/wire';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { collectDaemonSocketPaths } from './collect-daemon-socket-paths';
import type { LifecycleHost } from './lifecycle-host';
import { tryOpenDaemon } from './try-open-daemon';

// Where the command prints its result and its refusal: stdout and stderr by
// default.
interface BackupIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

const PROCESS_IO: BackupIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
};

// How long the handshake may take. The backup itself has no deadline, since
// its length grows with the database.
const PROBE_DEADLINE_MS = 3000;

/**
 * Asks the running daemon to write a consistent copy of its state database
 * to `path`, an absolute path on the daemon's host, and prints one line with
 * the path and the copy's size. It reaches the daemon over the owner's local
 * socket, the one this environment computes, else the one the daemon
 * recorded in the state directory, and never boots a daemon: with none
 * running, it prints a hint to stderr instead. A daemon that predates the
 * request, or that refuses it, gets one line on stderr too. Resolves to the
 * exit code: 0 once the daemon answered ok, else 1.
 */
export async function runDaemonBackup(
  host: LifecycleHost,
  path: string,
  io: BackupIO = PROCESS_IO,
): Promise<number> {
  const paths = buildHostDaemonPaths(host);

  const probe = await tryOpenDaemon(
    collectDaemonSocketPaths(paths),
    {
      build: host.invocation.readBuild(),
      deadline: host.clock.now() + PROBE_DEADLINE_MS,
      clock: host.clock,
      keepOpen: true,
    },
    (client: Readonly<DaemonClient>) => Promise.resolve(client),
  );

  if (probe === null) {
    io.printError(`atc backup: no daemon at ${paths.socketPath} — start one first`);

    return 1;
  }

  if (probe.kind === 'refused') {
    io.printError(`atc backup: ${probe.message}`);

    return 1;
  }

  const client = probe.value;

  try {
    const ok = await client.sendRequest('daemon.backup', { path });

    io.print(`atc backup: wrote ${String(ok['bytes'])} bytes to ${String(ok['path'])}`);

    return 0;
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'unknown_method') {
      io.printError(
        `atc backup: the running daemon (${probe.hello.build}) predates atc backup; restart it on this build with: atc daemon restart`,
      );

      return 1;
    }

    const code = error instanceof DaemonError ? `${error.code}: ` : '';

    io.printError(`atc backup: ${code}${error instanceof Error ? error.message : String(error)}`);

    return 1;
  } finally {
    client.stop();
  }
}
