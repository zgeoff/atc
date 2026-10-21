import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_KINDS, readSessionEnv, sendBridgeRequest } from '@atc/protocol/session';
import { sendReport } from './send-report';

interface NoteOptions {
  readonly message: string;

  // Comma-separated ids of every message one turn answered, recorded together.
  readonly messages: string;
  readonly label: string;

  // The turn whose final reply an `answered` envelope carries; empty when unknown.
  readonly turn: string;

  // Why the turn behind an `unanswered` envelope ended without an answer; empty
  // when unknown.
  readonly reason?: string;
}

// Where the reporter reads its text, prints its delivery result, and how it
// exits: stdin, stdout and the process by default.
interface NoteIO {
  readonly readStdin: () => Promise<string>;
  readonly print: (text: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: NoteIO = {
  readStdin: () => new Response(Bun.stdin.stream()).text(),
  print: (text) => {
    process.stdout.write(text);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export async function runNote(
  kind: string,
  options: NoteOptions,
  io: NoteIO = PROCESS_IO,
): Promise<void> {
  let isDelivered = false;

  try {
    const session = readSessionEnv(process.env);
    const sock = session.socket;
    const atcId = session.sessionID;

    if (sock !== undefined && atcId !== undefined && NOTE_KINDS.some((known) => known === kind)) {
      const stdin = kind === 'unanswered' ? '' : await io.readStdin();
      const payload = buildNotePayload(kind, options, stdin);

      if (payload !== null && session.bridge === true) {
        isDelivered = await sendBridgeNote(sock, session.outbox ?? '', payload);
      } else if (payload !== null) {
        const line = `${JSON.stringify({ atcId, event: 'Note', payload })}\n`;

        isDelivered = await sendReport(sock, line, 2000);
      }
    }
  } catch {}

  // The exit code stays 0, so a caller that must know whether atc took the
  // note reads this line instead.
  const delivery = isDelivered ? 'delivered' : 'undelivered';

  io.print(`${delivery}\n`);

  // always 0, so the note never blocks the session it reports on
  io.exit(0);
}

function buildNotePayload(
  kind: string,
  options: NoteOptions,
  stdin: string,
): Record<string, string | readonly string[]> | null {
  if (kind === 'answered') {
    const messages = options.messages.split(',').filter((id) => id !== '');
    const turn = options.turn === '' ? {} : { turn: options.turn };

    if (messages.length > 0) {
      return { kind, messages, answer: stdin, ...turn };
    }

    return options.message === ''
      ? null
      : { kind, message: options.message, answer: stdin, ...turn };
  }

  if (kind === 'unanswered') {
    const messages = options.messages.split(',').filter((id) => id !== '');
    const reason = options.reason ?? '';
    const turn = options.turn === '' ? {} : { turn: options.turn };

    return messages.length === 0 || reason === '' ? null : { kind, messages, reason, ...turn };
  }

  if (kind === 'note') {
    return stdin.trim() === ''
      ? null
      : { kind, label: options.label === '' ? 'progress' : options.label, text: stdin };
  }

  return null;
}

async function sendBridgeNote(
  sock: string,
  outbox: string,
  payload: Readonly<Record<string, string | readonly string[]>>,
): Promise<boolean> {
  // an id of its own, so a resent note lands once
  const noteID = randomUUID();
  const file = outbox === '' ? null : join(outbox, `${noteID}.json`);

  // the outbox holds the note until the bridge takes or refuses it, so the
  // session's tap sends it again after a dropped connection
  if (file !== null) {
    try {
      mkdirSync(outbox, { recursive: true });
      writeFileSync(file, JSON.stringify({ noteID, payload }));
    } catch {}
  }

  const answer = await sendBridgeRequest(sock, 'note', { noteID, payload }, 2000);

  // a refused note is final too, so it is never resent
  const isFinal = answer?.['ok'] === true || answer?.['code'] === 'forbidden';

  if (isFinal && file !== null) {
    rmSync(file, { force: true });
  }

  // Only a note the bridge took counts as delivered. A caller may then send
  // an answer again, which changes nothing once atc holds one.
  return answer?.['ok'] === true;
}
