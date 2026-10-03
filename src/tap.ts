import { z } from 'zod';
import { DaemonClient } from './client/daemon-client';
import { DaemonError } from './protocol/daemon-error';
import { runBridgeTap } from './run-bridge-tap';
import { daemonSocketPath } from './shared/config';
import { getBuild } from './shared/get-build';

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

/**
 * Streams one session's inbox to stdout, one NDJSON line per message, and
 * acks each message once its line is written. It talks to the daemon that
 * is already running and never boots one: a tap runs inside the session it
 * serves, so a restart from here would take the whole fleet down. Exits 1
 * with a hint when no daemon listens or the session cannot be tapped, and
 * 0 once the daemon closes the connection or ends the subscription because
 * another tap replaced it or the session was removed.
 */
export async function runTap(session: string): Promise<void> {
  const bridge = process.env['ATC_SOCKET'];

  // Inside a remote host the daemon's own socket is out of reach, and the
  // session bridge serves the tap instead.
  if (process.env['ATC_BRIDGE'] === '1' && bridge !== undefined && bridge !== '') {
    await runBridgeTap(bridge, process.env['ATC_OUTBOX'] ?? '');

    return;
  }

  let client: DaemonClient;

  try {
    client = await DaemonClient.open(daemonSocketPath);
  } catch {
    console.error(`atc tap: no daemon at ${daemonSocketPath} — start atc first`);
    process.exit(1);
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

    if (event.ev !== 'InboxMessage' || event['s'] !== session) {
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
      await ackInboxMessage(client, session, msg);
    })();
  };

  try {
    await client.sendHello(getBuild());
    await client.sendRequest('session.tap', { session });
  } catch (error) {
    console.error(`atc tap: ${formatError(error)}`);
    client.stop();
    process.exit(1);
  }

  await closed.promise;
  await written;

  process.exit(0);
}

interface RequestSender {
  readonly sendRequest: DaemonClient['sendRequest'];
}

async function ackInboxMessage(
  client: RequestSender,
  session: string,
  msg: InboxMessage,
): Promise<void> {
  const line = `${JSON.stringify({ id: msg.message, from: msg.from, text: msg.text, sentAt: msg.sentAt })}\n`;

  try {
    await Bun.write(Bun.stdout, line);
  } catch {
    process.exit(1);
  }

  try {
    await client.sendRequest('message.ack', { session, message: msg.message });
  } catch (error) {
    console.error(`atc tap: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof DaemonError ? `${error.code}: ${error.message}` : String(error);
}
