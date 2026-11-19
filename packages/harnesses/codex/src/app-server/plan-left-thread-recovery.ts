import type { UnsettledMessage } from '@atc/plugin-api';
import type { AppServerTurn } from './parse-app-server-turn';
import { planThreadRecovery } from './plan-thread-recovery';
import type { TurnSettlement } from './plan-turn-settlement';

export interface LeftThreadRecovery {
  readonly acks: readonly string[];
  readonly settlements: readonly TurnSettlement[];

  readonly stranded: readonly string[];

  readonly kept: readonly UnsettledMessage[];
}

export function planLeftThreadRecovery(
  messages: readonly UnsettledMessage[],
  turns: readonly AppServerTurn[] | null,
): LeftThreadRecovery {
  if (turns === null) {
    return { acks: [], settlements: [], stranded: messages.map((message) => message.id), kept: [] };
  }

  const recovery = planThreadRecovery(messages, turns);
  const stranded = [...recovery.carried.keys()];

  const held = new Set([
    ...recovery.settlements.flatMap((settlement) => settlement.messages),
    ...stranded,
  ]);

  return {
    acks: recovery.acks,
    settlements: recovery.settlements,
    stranded,
    kept: messages.filter((message) => !held.has(message.id)),
  };
}
