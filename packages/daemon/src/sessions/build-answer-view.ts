import { encodeCursor } from '@atc/protocol';
import type { StoredAnswer } from '@atc/store';
import type { SessionDescriptor } from '@atcx/contract';

export interface AnswerView {
  readonly answer: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly message: string;
  readonly text: string;
  readonly complete: boolean;
}

export function buildAnswerView(
  stored: StoredAnswer,
  sessions: readonly SessionDescriptor[],
  aliases: readonly SessionDescriptor[],
): AnswerView {
  // A restored session gets a new atc id, so a stored row can hold the id of an earlier run.
  // The agent session id is the only value that still finds the live session.
  const live =
    sessions.find((session) => session.id === stored.atcID) ??
    (stored.agentSessionID === null
      ? undefined
      : aliases.find((session) => session.agentSessionID === stored.agentSessionID));

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
