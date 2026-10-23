import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { openBridgeSocket } from '@atc/protocol/session';
import type { BridgeSocket } from '@atc/protocol/session';
import { MESSAGE_SENDER_SCHEMA } from '@atc/protocol/wire';
import { z } from 'zod';
import { renderMessageLine } from './render-message-line';
import { renderNoticeLine } from './render-notice-line';

// The wait before the first reconnect, doubling up to the longest.
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 5000;

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

interface RunBridgeTapOptions {
  readonly io?: BridgeTapIO;
  readonly notices?: boolean;
  readonly clock?: Clock;
}

export async function runBridgeTap(
  socketPath: string,
  outbox: string,
  options: RunBridgeTapOptions = {},
): Promise<void> {
  const io = options.io ?? PROCESS_IO;
  const notices = options.notices ?? false;
  const clock = options.clock ?? systemClock;

  const seen = new Set<string>();

  let wait = FIRST_RETRY_MS;

  // a dropped connection, as a host's sleep or a daemon restart leaves it,
  // reconnects with no end
  for (;;) {
    const end = await runTapConnection({ socketPath, outbox, seen, io, notices, clock });

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

    const slept = Promise.withResolvers<void>();

    clock.schedule(slept.resolve, wait);

    await slept.promise;

    wait = Math.min(wait * 2, LONGEST_RETRY_MS);
  }
}

// How one connection to the bridge ended: the inbox closed for good, the
// bridge refused the tap, the connection dropped after it opened the tap, or
// it dropped or went unanswered before then.
type TapEnd = 'closed' | 'refused' | 'lost' | 'unreachable';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  ev: z.literal('InboxMessage'),
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
  ev: z.literal('InboxNotice'),
  message: z.string(),
  from: z.string(),
  status: z.enum(['answered', 'unanswered']),
  answer: z.string().optional(),
  reason: z.string().optional(),
});

// A relay can take the connection and never pass tap.open on, so an open with no answer by then
// goes the way of a connection that dropped.
const OPEN_ANSWER_TIMEOUT_MS = 10_000;

interface RunTapConnectionOptions {
  readonly socketPath: string;
  readonly outbox: string;
  readonly seen: Set<string>;
  readonly io: BridgeTapIO;
  readonly notices: boolean;
  readonly clock: Clock;
}

async function runTapConnection(options: RunTapConnectionOptions): Promise<TapEnd> {
  const ended = Promise.withResolvers<TapEnd>();
  let opened = false;
  let printing: Promise<void> = Promise.resolve();
  let socket: BridgeSocket;

  // The outbox file behind each note this connection sent, by request id.
  let sent = new Map<string, string>();

  // Prints one line once per seen key, then acks it, in arrival order: one
  // already printed on an earlier connection is acked again and not
  // printed twice.
  const schedulePrint = (key: string, printed: string, ack: Readonly<Record<string, unknown>>) => {
    const previous = printing;

    printing = (async () => {
      await previous;

      if (!options.seen.has(key)) {
        try {
          await options.io.writeStdout(printed);
        } catch {
          options.io.exit(1);

          return;
        }

        updateSeenIDs(options.seen, key);
      }

      socket.writeLine(ack);
    })();
  };

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
      sent = sendOutboxNotes(socket, options.outbox);

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

    const notice = INBOX_NOTICE_SCHEMA.safeParse(line);

    if (notice.success) {
      if (options.notices) {
        schedulePrint(`notice:${notice.data.message}`, renderNoticeLine(notice.data), {
          version: 1,
          id: `notice-ack:${notice.data.message}`,
          op: 'tap.notice-ack',
          message: notice.data.message,
        });
      }

      return;
    }

    const parsedMessage = INBOX_MESSAGE_SCHEMA.safeParse(line);

    if (!parsedMessage.success) {
      return;
    }

    const message = parsedMessage.data;

    schedulePrint(`message:${message.message}`, renderMessageLine(message), {
      version: 1,
      id: `ack:${message.message}`,
      op: 'tap.ack',
      message: message.message,
    });
  };

  try {
    socket = await openBridgeSocket(options.socketPath, onLine);
  } catch {
    return 'unreachable';
  }

  void (async () => {
    await socket.closed;

    const end: TapEnd = opened ? 'lost' : 'unreachable';

    ended.resolve(end);
  })();

  const open = options.notices
    ? { version: 1, id: 'tap.open', op: 'tap.open', notices: true }
    : { version: 1, id: 'tap.open', op: 'tap.open' };

  socket.writeLine(open);

  const cancelOpenDeadline = options.clock.schedule(() => {
    if (!opened) {
      ended.resolve('unreachable');
    }
  }, OPEN_ANSWER_TIMEOUT_MS);

  const end = await ended.promise;

  cancelOpenDeadline();

  await printing.catch(() => {});

  socket.end();

  return end;
}

// How many message and notice ids the tap remembers having printed.
const SEEN_LIMIT = 10_000;

function updateSeenIDs(seen: Set<string>, id: string): void {
  seen.add(id);

  for (const oldest of seen) {
    if (seen.size <= SEEN_LIMIT) {
      break;
    }

    seen.delete(oldest);
  }
}

const OUTBOX_NOTE_SCHEMA = z.object({
  noteID: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

// Sends every note the outbox holds, and returns the file behind each
// request id it sent; a file that is no note is removed, since no answer
// would ever clear it.
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
      version: 1,
      id,
      op: 'note',
      noteID: note.noteID,
      payload: note.payload,
    });
  }

  return sent;
}
