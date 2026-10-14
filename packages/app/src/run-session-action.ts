import type { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DaemonError } from '@atc/protocol/daemon-error';

// What `atc session` does to one session: rebind its host's runtime auth,
// or start a terminal for it.
type SessionAction = 'rebind' | 'adopt';

// Where the command prints its result and its refusal: stdout and stderr by
// default.
interface SessionActionIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

// The terminal size an adopted session starts at.
interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

const PROCESS_IO: SessionActionIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
};

/**
 * Runs one `atc session` action against the daemon and prints one line on
 * its outcome. A rebind binds the session's host to its agent's current
 * auth selection and starts nothing, so its line holds the adopt command
 * that starts the session; an adopt starts the session's terminal at the
 * given size. A refusal prints the daemon's code and message to stderr.
 * Resolves to the exit code: 0 once the daemon answered ok, else 1.
 */
export async function runSessionAction(
  client: Pick<DaemonClient, 'sendRequest'>,
  action: SessionAction,
  session: string,
  size: TerminalSize,
  io: SessionActionIO = PROCESS_IO,
): Promise<number> {
  try {
    if (action === 'rebind') {
      const ok = await client.sendRequest('session.auth.rebind', { session });

      io.print(
        `rebound the host of session ${session} at revision ${String(ok['revision'])}; start it with: atc session adopt ${session}`,
      );
    } else {
      await client.sendRequest('session.adopt', { session, cols: size.cols, rows: size.rows });

      io.print(`started a terminal for session ${session}`);
    }

    return 0;
  } catch (error) {
    const code = error instanceof DaemonError ? `${error.code}: ` : '';

    io.printError(
      `atc session ${action}: ${code}${error instanceof Error ? error.message : String(error)}`,
    );

    return 1;
  }
}
