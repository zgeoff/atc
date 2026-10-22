import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

// What `atc session` does to one session: rebind its host's runtime auth,
// or start a terminal for it.
type SessionAction = 'rebind' | 'adopt';

// The terminal size an adopted session starts at.
interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export async function runSessionAction(
  client: Pick<DaemonClient, 'sendRequest'>,
  action: SessionAction,
  session: string,
  size: TerminalSize,
  io: Pick<ProcessIO, 'print' | 'printError'> = PROCESS_IO,
): Promise<number> {
  try {
    if (action === 'rebind') {
      const ok = await client.sendRequest('session.auth.rebind', { session });

      io.print(
        `rebound the host of session ${session} at revision ${String(ok['revision'])}; start it with: atc session adopt ${session}`,
      );

      const pending = Array.isArray(ok['restartPending']) ? ok['restartPending'] : [];

      if (pending.length > 0) {
        io.print(
          `these sessions keep an older revision's settings until their next launch: ${pending.map(String).join(', ')}; stop a running one, then atc session adopt <session_id>`,
        );
      }
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
