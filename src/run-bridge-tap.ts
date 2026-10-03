import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { openBridgeSocket } from './shared/open-bridge-socket';
import type { BridgeSocket } from './shared/open-bridge-socket';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  ev: z.literal('InboxMessage'),
  message: z.string(),
  from: z.string(),
  text: z.string(),
  sentAt: z.number(),
});

const OUTBOX_REPORT_SCHEMA = z.object({
  reportID: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

// The wait before the first reconnect, doubling up to the longest.
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 5000;

// How many message ids the tap remembers having printed.
const SEEN_LIMIT = 10_000;

// How one connection to the bridge ended: the inbox closed for good, the
// bridge refused the tap, or the connection dropped after or before it
// opened the tap.
type TapEnd = 'closed' | 'refused' | 'lost' | 'unreachable';

/**
 * Streams the session's inbox to stdout from inside a remote host, through
 * the session bridge at the given socket. It prints each message once as
 * one NDJSON line and acks it after the line is written. A dropped
 * connection, as a host's sleep or a daemon restart leaves it, reconnects
 * with a growing wait of at most 5 seconds and no end; each new connection
 * replays the messages not yet acked, and one already printed is acked
 * again and not printed twice. Each connection also sends the reports the
 * outbox still holds. Exits 0 once the inbox closes and 1 when the bridge
 * refuses the tap.
 */
export async function runBridgeTap(socketPath: string, outbox: string): Promise<void> {
  const seen = new Set<string>();

  let wait = FIRST_RETRY_MS;

  for (;;) {
    const end = await runTapConnection(socketPath, outbox, seen);

    if (end === 'closed') {
      process.exit(0);
    }

    if (end === 'refused') {
      console.error('atc tap: the session bridge refused the tap');
      process.exit(1);
    }

    if (end === 'lost') {
      wait = FIRST_RETRY_MS;
    }

    await Bun.sleep(wait);

    wait = Math.min(wait * 2, LONGEST_RETRY_MS);
  }
}

async function runTapConnection(
  socketPath: string,
  outbox: string,

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the ids the tap printed, which every connection adds to
  seen: Set<string>,
): Promise<TapEnd> {
  const ended = Promise.withResolvers<TapEnd>();
  let opened = false;
  let printing: Promise<void> = Promise.resolve();
  let socket: BridgeSocket;

  // The outbox file behind each report this connection sent, by request id.
  let sent = new Map<string, string>();

  const onLine = (line: Readonly<Record<string, unknown>>) => {
    if (line['ev'] === 'InboxClosed') {
      ended.resolve('closed');

      return;
    }

    if (line['id'] === 'tap.open') {
      if (line['ok'] !== true) {
        ended.resolve('refused');

        return;
      }

      opened = true;
      sent = sendOutboxReports(socket, outbox);

      return;
    }

    // A report the bridge took, or one it refuses outright, leaves the
    // outbox: no resend would change the answer. Only the file this
    // connection sent under the answered id is removed.
    if (typeof line['id'] === 'string' && line['id'].startsWith('report:')) {
      const path = sent.get(line['id']);

      if (path !== undefined && (line['ok'] === true || line['code'] === 'forbidden')) {
        sent.delete(line['id']);

        rmSync(path, { force: true });
      }

      return;
    }

    if (line['ok'] === false && line['code'] === 'stale_binding') {
      ended.resolve('refused');

      return;
    }

    const msg = INBOX_MESSAGE_SCHEMA.safeParse(line);

    if (!msg.success) {
      return;
    }

    const message = msg.data;
    const previous = printing;

    printing = (async () => {
      await previous;

      if (!seen.has(message.message)) {
        const printed = `${JSON.stringify({ id: message.message, from: message.from, text: message.text, sentAt: message.sentAt })}\n`;

        try {
          await Bun.write(Bun.stdout, printed);
        } catch {
          process.exit(1);
        }

        updateSeenIDs(seen, message.message);
      }

      socket.writeLine({
        v: 1,
        id: `ack:${message.message}`,
        op: 'tap.ack',
        message: message.message,
      });
    })();
  };

  try {
    socket = await openBridgeSocket(socketPath, onLine);
  } catch {
    return 'unreachable';
  }

  void (async () => {
    await socket.closed;

    const end: TapEnd = opened ? 'lost' : 'unreachable';

    ended.resolve(end);
  })();

  socket.writeLine({ v: 1, id: 'tap.open', op: 'tap.open' });

  const end = await ended.promise;

  await printing.catch(() => {});

  socket.end();

  return end;
}

// Sends every report the outbox holds, and returns the file behind each
// request id it sent; a file that is no report is removed, since no answer
// would ever clear it.
// oxlint-disable-next-line prefer-readonly-parameter-types -- a socket is a live handle
function sendOutboxReports(socket: BridgeSocket, outbox: string): Map<string, string> {
  const sent = new Map<string, string>();

  let files: string[];

  try {
    files = readdirSync(outbox).filter((file) => file.endsWith('.json'));
  } catch {
    return sent;
  }

  for (const file of files) {
    const path = join(outbox, file);
    let report: z.infer<typeof OUTBOX_REPORT_SCHEMA> | null = null;

    try {
      const parsed = OUTBOX_REPORT_SCHEMA.safeParse(JSON.parse(readFileSync(path, 'utf8')));

      report = parsed.success ? parsed.data : null;
    } catch {}

    if (report === null) {
      rmSync(path, { force: true });
      continue;
    }

    const id = `report:${report.reportID}`;

    sent.set(id, path);

    socket.writeLine({
      v: 1,
      id,
      op: 'report',
      reportID: report.reportID,
      payload: report.payload,
    });
  }

  return sent;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the set grows in place
function updateSeenIDs(seen: Set<string>, id: string): void {
  seen.add(id);

  for (const oldest of seen) {
    if (seen.size <= SEEN_LIMIT) {
      break;
    }

    seen.delete(oldest);
  }
}
