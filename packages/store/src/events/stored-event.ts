import type { AgentSessionID, MessageID, RestartResult, SessionID } from '@atcx/contract';

export interface EventScope {
  readonly atcIDs: readonly SessionID[];

  // Rows can carry an earlier atc id, so the scope matches agent session ids too.
  readonly agentSessionIDs: readonly AgentSessionID[];
}

export interface TrailRow {
  readonly id: number;

  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly event: string;
  readonly kind: string | null;
}

export interface StoredEvent {
  readonly id: number;

  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly kind: string;

  readonly detail: string | null;

  readonly message?: MessageID;

  readonly label?: string;

  readonly result?: RestartResult;
}

export interface StoredNote {
  readonly id: number;

  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly label: string;
  readonly text: string;

  readonly complete: boolean;
}

export interface StoredAnswer {
  readonly id: number;

  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly message: MessageID;
  readonly text: string;

  readonly complete: boolean;
}
