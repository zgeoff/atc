import { daemonSocketPath } from '@atc/config/config';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DaemonError } from '@atc/protocol/daemon-error';
import { readSessionEnv } from '@atc/protocol/read-session-env';
import { z } from 'zod';
import { buildHostServices } from './build-host-services';
import { renderNoticeLine } from './render-notice-line';
import { runBridgeTap } from './run-bridge-tap';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),
  text: z.string(),
  sentAt: z.number(),
});

interface InboxMessage {
  readonly message: string;
  readonly from: string;
  readonly text: string;
  readonly sentAt: number;
}

const INBOX_NOTICE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),
  status: z.enum(['answered', 'unanswered']),
  answer: z.string().optional(),
  reason: z.string().optional(),
});

type InboxNotice = z.output<typeof INBOX_NOTICE_SCHEMA>;

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

/**
 * Streams one session's inbox to stdout, one NDJSON line per message, and
 * acks each message once its line is written. With `notices`, it also
 * streams the answer notices of the messages the session sent, one line
 * each, `kind` "answer", with no `text`, and acks each one the same way. It talks to the daemon that
 * is already running and never boots one: a tap runs inside the session it
 * serves, so a restart from here would take the whole fleet down. Exits 1
 * with a hint when no daemon listens or the session cannot be tapped, and
 * 0 once the daemon closes the connection or ends the subscription because
 * another tap replaced it or the session was removed. It dials the daemon
 * at `socketPath`, the running daemon's socket by default.
 */
export async function runTap(
  session: string,
  socketPath: string = daemonSocketPath,
  io: TapIO = PROCESS_IO,
  notices = false,
): Promise<void> {
  const inherited = readSessionEnv(process.env);

  // Inside a remote host the daemon's own socket is out of reach, and the
  // session bridge serves the tap instead.
  if (inherited.bridge === true && inherited.socket !== undefined) {
    await runBridgeTap(inherited.socket, inherited.outbox ?? '', io, notices);

    return;
  }

  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
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
    if (event.ev === 'InboxClosed' && event['s'] === session) {
      closed.resolve();

      return;
    }

    if (event['s'] !== session) {
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

    const msg: InboxMessage = {
      message: parsed.data.message,
      from: parsed.data.from,
      text: parsed.data.text,
      sentAt: parsed.data.sentAt,
    };

    const previous = written;

    written = (async () => {
      await previous;
      await ackInboxMessage(client, session, msg, io);
    })();
  };

  try {
    await client.sendHello(buildHostServices().build, {
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

async function ackInboxMessage(
  client: RequestSender,
  session: string,
  msg: InboxMessage,
  io: TapIO,
): Promise<void> {
  const line = `${JSON.stringify({ id: msg.message, from: msg.from, text: msg.text, sentAt: msg.sentAt })}\n`;

  try {
    await io.writeStdout(line);
  } catch {
    io.exit(1);

    return;
  }

  try {
    await client.sendRequest('message.ack', { session, message: msg.message });
  } catch (error) {
    io.printError(`atc tap: ${formatError(error)}`);
  }
}

async function ackInboxNotice(
  client: RequestSender,
  session: string,
  notice: InboxNotice,
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
