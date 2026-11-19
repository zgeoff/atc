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

interface RunSessionActionOptions {
  readonly action: SessionAction;
  readonly session: string;
  readonly size: TerminalSize;
  readonly io?: Pick<ProcessIO, 'print' | 'printError'>;
}

export async function runSessionAction(
  client: Pick<DaemonClient, 'sendRequest'>,
  options: RunSessionActionOptions,
): Promise<number> {
  const io = options.io ?? PROCESS_IO;

  try {
    if (options.action === 'rebind') {
      const ok = await client.sendRequest('session.auth.rebind', { session: options.session });

      io.print(
        `rebound the host of session ${options.session} at revision ${String(ok['revision'])}; start it with: atc session adopt ${options.session}`,
      );

      const pending = Array.isArray(ok['restartPending']) ? ok['restartPending'] : [];

      if (pending.length > 0) {
        io.print(
          `these sessions keep an older revision's settings until their next launch: ${pending.map(String).join(', ')}; stop a running one, then atc session adopt <session_id>`,
        );
      }
    } else {
      await client.sendRequest('session.adopt', {
        session: options.session,
        cols: options.size.cols,
        rows: options.size.rows,
      });

      io.print(`started a terminal for session ${options.session}`);
    }

    return 0;
  } catch (error) {
    const code = error instanceof DaemonError ? `${error.code}: ` : '';

    io.printError(
      `atc session ${options.action}: ${code}${error instanceof Error ? error.message : String(error)}`,
    );

    return 1;
  }
}
