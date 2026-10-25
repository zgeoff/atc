import type { AgentSessionID, MessageID, RestartResult, SessionID } from '@atcx/contract';

export interface EventScope {
  readonly atcIDs: readonly SessionID[];

  // A row written before atc session ids stayed stable across restores
  // carries an earlier atc id, so the scope matches agent session ids too.
  readonly agentSessionIDs: readonly AgentSessionID[];
}

export interface StoredEvent {
  readonly id: number;

  // Epoch ms of ts.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly kind: string;

  // The event's detail, else the hook's message.
  readonly detail: string | null;

  // The message id on a message status event.
  readonly message?: MessageID;

  // The note label on a note event.
  readonly label?: string;

  // The whole result on a daemon-restarted event.
  readonly result?: RestartResult;
}

export interface StoredNote {
  readonly id: number;

  // Epoch ms the note arrived.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly label: string;
  readonly text: string;

  // False for a note recorded before the trail kept whole texts, whose text
  // is its preview.
  readonly complete: boolean;
}

export interface StoredAnswer {
  readonly id: number;

  // Epoch ms the message was answered.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly message: MessageID;
  readonly text: string;

  // False for an answer recorded before the trail kept whole answers, whose
  // text is its preview.
  readonly complete: boolean;
}
