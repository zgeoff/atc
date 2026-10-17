import type { UnsettledMessage } from '@atc/plugin-api';
import type { AppServerTurn } from './parse-app-server-turn';
import { planThreadRecovery } from './plan-thread-recovery';
import type { TurnSettlement } from './plan-turn-settlement';

export interface LeftThreadRecovery {
  readonly acks: readonly string[];
  readonly settlements: readonly TurnSettlement[];

  // messages that a running turn of the left thread holds, or that it may hold when its turns
  // could not be read; no turn of the thread the bridge serves will carry them
  readonly stranded: readonly string[];

  // messages that no turn of the left thread holds, which the recovery of the thread the bridge
  // serves settles
  readonly kept: readonly UnsettledMessage[];
}

// null turns stand for a thread whose history the server refused to read
export function planLeftThreadRecovery(
  messages: readonly UnsettledMessage[],
  turns: readonly AppServerTurn[] | null,
): LeftThreadRecovery {
  if (turns === null) {
    return { acks: [], settlements: [], stranded: messages.map((m) => m.id), kept: [] };
  }

  const recovery = planThreadRecovery(messages, turns);
  const stranded = [...recovery.carried.keys()];

  const held = new Set([...recovery.settlements.flatMap((s) => s.messages), ...stranded]);

  return {
    acks: recovery.acks,
    settlements: recovery.settlements,
    stranded,
    kept: messages.filter((m) => !held.has(m.id)),
  };
}
