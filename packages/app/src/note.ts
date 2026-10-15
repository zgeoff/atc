import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTE_KINDS, readSessionEnv, sendBridgeRequest } from '@atc/protocol/session';
import { sendReport } from './shared/report';

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

// Where the reporter reads its text and how it exits: stdin and the process
// by default.
interface NoteIO {
  readonly readStdin: () => Promise<string>;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: NoteIO = {
  readStdin: () => new Response(Bun.stdin.stream()).text(),
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Runs inside wrangled sessions: reads stdin verbatim and forwards it to the
 * atc socket as a Note envelope of the given kind. An `answered` envelope
 * carries stdin as the final reply of the turn that carried the given
 * message, or every given message at once, plus that turn's id when one is
 * given; an `unanswered` envelope reports that the turn that carried the given
 * messages ended without an answer, with the reason and no stdin; a `note`
 * carries it as text for the user under the given label,
 * `progress` when none is given. Inside a remote host it goes to the session bridge instead. Always
 * exits 0 so it never blocks the session it reports on.
 */
export async function runNote(
  kind: string,
  options: NoteOptions,
  io: NoteIO = PROCESS_IO,
): Promise<void> {
  try {
    const session = readSessionEnv(process.env);
    const sock = session.socket;
    const atcId = session.sessionID;

    if (sock !== undefined && atcId !== undefined && NOTE_KINDS.some((known) => known === kind)) {
      const stdin = kind === 'unanswered' ? '' : await io.readStdin();
      const payload = buildNotePayload(kind, options, stdin);

      if (payload !== null && session.bridge === true) {
        await sendBridgeNote(sock, session.outbox ?? '', payload);
      } else if (payload !== null) {
        const line = `${JSON.stringify({ atcId, event: 'Note', payload })}\n`;

        await sendReport(sock, line, 2000);
      }
    }
  } catch {}

  io.exit(0);
}

// Inside a remote host, a note goes to the session bridge under an id of
// its own, and waits in the outbox until the bridge takes or refuses it, so
// the session's tap sends it again after a dropped connection. A resent
// note lands once, and a refused one is never resent.
async function sendBridgeNote(
  sock: string,
  outbox: string,
  payload: Readonly<Record<string, string | readonly string[]>>,
): Promise<void> {
  const noteID = randomUUID();
  const file = outbox === '' ? null : join(outbox, `${noteID}.json`);

  if (file !== null) {
    try {
      mkdirSync(outbox, { recursive: true });
      writeFileSync(file, JSON.stringify({ noteID, payload }));
    } catch {}
  }

  const answer = await sendBridgeRequest(sock, 'note', { noteID, payload }, 2000);

  const isFinal = answer?.['ok'] === true || answer?.['code'] === 'forbidden';

  if (isFinal && file !== null) {
    rmSync(file, { force: true });
  }
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
