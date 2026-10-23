import { daemonSocketPath } from '@atc/config/host';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { DaemonError, MESSAGE_SENDER_SCHEMA } from '@atc/protocol/wire';
import { z } from 'zod';
import { renderMessageLine } from './render-message-line';
import { renderNoticeLine } from './render-notice-line';
import { runBridgeTap } from './run-bridge-tap';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),

  // A sender this build cannot read is left out, and the message still
  // goes out with its sender's name.
  sender: z.preprocess(
    (value) => (MESSAGE_SENDER_SCHEMA.safeParse(value).success ? value : undefined),
    MESSAGE_SENDER_SCHEMA.optional(),
  ),
  text: z.string(),
  sentAt: z.number(),
});

const INBOX_NOTICE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),
  status: z.enum(['answered', 'unanswered']),
  answer: z.string().optional(),
  reason: z.string().optional(),
});

// Where the tap prints and how it exits: stdout, stderr, and the process by
// default.
interface TapIO {
  readonly writeStdout: (text: string) => Promise<unknown>;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: TapIO = {
  writeStdout: (text) => Bun.write(Bun.stdout, text),
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => {
    process.exit(code);
  },
};

interface RunTapOptions {
  readonly socketPath?: string;
  readonly io?: TapIO;
  readonly notices?: boolean;
}

// `build` is the build the tap's handshake names.
export async function runTap(
  session: string,
  build: string,
  options: RunTapOptions = {},
): Promise<void> {
  const socketPath = options.socketPath ?? daemonSocketPath;
  const io = options.io ?? PROCESS_IO;
  const notices = options.notices ?? false;
  const inherited = readSessionEnv(process.env);

  // Inside a remote host the daemon's own socket is out of reach, and the
  // session bridge serves the tap instead.
  if (inherited.bridge === true && inherited.socket !== undefined) {
    await runBridgeTap(inherited.socket, inherited.outbox ?? '', { io, notices });

    return;
  }

  let client: DaemonClient;

  try {
    // never boots a daemon: a tap runs inside the session it serves, so a
    // restart from here would take the whole fleet down
    client = await openDaemonClient(socketPath);
  } catch {
    io.printError(`atc tap: no daemon at ${socketPath} — start atc first`);
    io.exit(1);

    return;
  }

  const closed = Promise.withResolvers<void>();
  let written: Promise<void> = Promise.resolve();

  client.onClose = () => {
    closed.resolve();
  };

  client.onEvent = (event) => {
    const eventSession = 'sessionID' in event ? event.sessionID : null;

    if (event.ev === 'InboxClosed' && eventSession === session) {
      closed.resolve();

      return;
    }

    if (eventSession !== session) {
      return;
    }

    if (event.ev === 'InboxNotice' && notices) {
      const notice = INBOX_NOTICE_SCHEMA.safeParse(event);

      if (notice.success) {
        const previous = written;

        written = (async () => {
          await previous;
          await ackInboxNotice(client, session, notice.data, io);
        })();
      }

      return;
    }

    if (event.ev !== 'InboxMessage') {
      return;
    }

    const parsed = INBOX_MESSAGE_SCHEMA.safeParse(event);

    if (!parsed.success) {
      return;
    }

    const message = parsed.data;
    const previous = written;

    written = (async () => {
      await previous;

      await ackInboxMessage({
        client,
        session,
        message: message.message,
        line: renderMessageLine(message),
        io,
      });
    })();
  };

  try {
    await client.sendHello(build, {
      session: readSessionEnv(process.env).sessionID,
    });

    const tapParams = notices ? { session, notices: true } : { session };

    await client.sendRequest('session.tap', tapParams);
  } catch (error) {
    io.printError(`atc tap: ${formatError(error)}`);
    client.stop();
    io.exit(1);

    return;
  }

  await closed.promise;
  await written;

  client.stop();
  io.exit(0);
}

interface RequestSender {
  readonly sendRequest: DaemonClient['sendRequest'];
}

type InboxNotice = z.output<typeof INBOX_NOTICE_SCHEMA>;

async function ackInboxNotice(
  client: RequestSender,
  session: string,
  notice: Readonly<InboxNotice>,
  io: TapIO,
): Promise<void> {
  try {
    await io.writeStdout(renderNoticeLine(notice));
  } catch {
    io.exit(1);

    return;
  }

  try {
    await client.sendRequest('notice.ack', { session, message: notice.message });
  } catch (error) {
    io.printError(`atc tap: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof DaemonError ? `${error.code}: ${error.message}` : String(error);
}

interface AckInboxMessageOptions {
  readonly client: RequestSender;
  readonly session: string;
  readonly message: string;
  readonly line: string;
  readonly io: TapIO;
}

async function ackInboxMessage(options: AckInboxMessageOptions): Promise<void> {
  try {
    await options.io.writeStdout(options.line);
  } catch {
    options.io.exit(1);

    return;
  }

  try {
    // acks only once the line is written
    await options.client.sendRequest('message.ack', {
      session: options.session,
      message: options.message,
    });
  } catch (error) {
    options.io.printError(`atc tap: ${formatError(error)}`);
  }
}
