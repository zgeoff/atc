export type IdempotencyState = 'in_progress' | 'completed' | 'outcome_unknown';

export interface IdempotencyRecord {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly state: IdempotencyState;

  readonly effectRef: string;

  readonly result: string | null;

  readonly effectTarget: EffectTarget | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EffectTarget {
  readonly target: string;
  readonly targetIdentity: string;
}

export interface IdempotencyClaim {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly effectRef: string;
  readonly at: number;
}
