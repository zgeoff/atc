/**
 * Where a keyed effect stands. `in_progress` holds while the daemon that
 * claimed the key runs the effect; `completed` once the effect is durable;
 * `outcome_unknown` when a daemon stopped mid-effect and its start-up
 * reconciliation found no trace of the effect.
 */
export type IdempotencyState = 'in_progress' | 'completed' | 'outcome_unknown';

// One idempotency key and the effect it names.
export interface IdempotencyRecord {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly state: IdempotencyState;

  // The id the effect was minted before it ran: the session a spawn
  // created, or the message a send wrote.
  readonly effectRef: string;

  // The effect's answer as JSON, once completed by the daemon that ran it.
  readonly result: string | null;

  // The target the completed effect's session was bound to, as it stood
  // then; null for a key completed without one.
  readonly effectTarget: EffectTarget | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A target name and the identity it held, which a replay of the key is
 * authorized against.
 */
export interface EffectTarget {
  readonly target: string;
  readonly targetIdentity: string;
}

// The claim a keyed request makes before its effect runs.
export interface IdempotencyClaim {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly effectRef: string;
  readonly at: number;
}
