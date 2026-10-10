import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { openBridgeSocket } from './protocol/open-bridge-socket';
import type { BridgeSocket } from './protocol/open-bridge-socket';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  ev: z.literal('InboxMessage'),
  message: z.string(),
  from: z.string(),
  text: z.string(),
  sentAt: z.number(),
});

// Outbox files written by earlier releases hold `reportID` for the value a
// note file holds as `noteID`; both read as a note.
const OUTBOX_NOTE_SCHEMA = z
  .object({
    noteID: z.string().min(1).optional(),
    reportID: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .transform((file, ctx) => {
    const noteID = file.noteID ?? file.reportID;

    if (noteID === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a note file needs an ID' });

      return z.NEVER;
    }

    return { noteID, payload: file.payload };
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

// Where the tap prints and how it exits: stdout, stderr, and the process by
// default.
interface BridgeTapIO {
  readonly writeStdout: (text: string) => Promise<unknown>;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: BridgeTapIO = {
  writeStdout: (text) => Bun.write(Bun.stdout, text),
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Streams the session's inbox to stdout from inside a remote host, through
 * the session bridge at the given socket. It prints each message once as
 * one NDJSON line and acks it after the line is written. A dropped
 * connection, as a host's sleep or a daemon restart leaves it, reconnects
 * with a growing wait of at most 5 seconds and no end; each new connection
 * replays the messages not yet acked, and one already printed is acked
 * again and not printed twice. Each connection also sends the notes the
 * outbox still holds. Exits 0 once the inbox closes and 1 when the bridge
 * refuses the tap.
 */
export async function runBridgeTap(
  socketPath: string,
  outbox: string,
  io: BridgeTapIO = PROCESS_IO,
): Promise<void> {
  const seen = new Set<string>();

  let wait = FIRST_RETRY_MS;

  for (;;) {
    const end = await runTapConnection(socketPath, outbox, seen, io);

    if (end === 'closed') {
      io.exit(0);

      return;
    }

    if (end === 'refused') {
      io.printError('atc tap: the session bridge refused the tap');
      io.exit(1);

      return;
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
  io: BridgeTapIO,
): Promise<TapEnd> {
  const ended = Promise.withResolvers<TapEnd>();
  let opened = false;
  let printing: Promise<void> = Promise.resolve();
  let socket: BridgeSocket;

  // The outbox file behind each note this connection sent, by request id.
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
      sent = sendOutboxNotes(socket, outbox);

      return;
    }

    // A note the bridge took, or one it refuses outright, leaves the
    // outbox: no resend would change the answer. Only the file this
    // connection sent under the answered id is removed.
    if (typeof line['id'] === 'string' && line['id'].startsWith('note:')) {
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
          await io.writeStdout(printed);
        } catch {
          io.exit(1);

          return;
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

// Sends every note the outbox holds, and returns the file behind each
// request id it sent; a file that is no note is removed, since no answer
// would ever clear it.
// oxlint-disable-next-line prefer-readonly-parameter-types -- a socket is a live handle
function sendOutboxNotes(socket: BridgeSocket, outbox: string): Map<string, string> {
  const sent = new Map<string, string>();

  let files: string[];

  try {
    files = readdirSync(outbox).filter((file) => file.endsWith('.json'));
  } catch {
    return sent;
  }

  for (const file of files) {
    const path = join(outbox, file);
    let note: z.output<typeof OUTBOX_NOTE_SCHEMA> | null = null;

    try {
      const parsed = OUTBOX_NOTE_SCHEMA.safeParse(JSON.parse(readFileSync(path, 'utf8')));

      note = parsed.success ? parsed.data : null;
    } catch {}

    if (note === null) {
      rmSync(path, { force: true });
      continue;
    }

    const id = `note:${note.noteID}`;

    sent.set(id, path);

    socket.writeLine({
      v: 1,
      id,
      op: 'note',
      noteID: note.noteID,
      payload: note.payload,
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
