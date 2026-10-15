import { encodeCursor } from '@atc/protocol';
import type { SessionDescriptor } from '@atc/protocol';
import type { StoredAnswer } from '@atc/store';

/**
 * One message answer as `answer.get` returns it: the cursor of its
 * message-answered event, when the message was answered, the session that
 * answered it and that session's name, the message id, the answer text,
 * and whether that text is whole.
 */
export interface AnswerView {
  readonly answer: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly message: string;
  readonly text: string;
  readonly complete: boolean;
}

/**
 * Builds the view from the sessions that may name it. A row written before
 * atc session ids stayed stable across restores carries an earlier atc id,
 * so a session of `aliases` that holds its agent session id names it when
 * no session holds the atc id. The alias only names the answer: whoever
 * checks who may read it checks the row's own atc id.
 */
export function buildAnswerView(
  stored: StoredAnswer,
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[],
): AnswerView {
  const live =
    sessions.find((s) => s.id === stored.atcID) ??
    (stored.agentSessionID === null
      ? undefined
      : aliases.find((s) => s.agentSessionID === stored.agentSessionID));

  return {
    answer: encodeCursor({ kind: 'events', id: stored.id }),
    at: stored.at,
    session: live?.id ?? stored.atcID,
    name: live?.name ?? null,
    message: stored.message,
    text: stored.text,
    complete: stored.complete,
  };
}
