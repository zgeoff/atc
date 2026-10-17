import type { UnsettledMessage } from '@atc/plugin-api';
import type { AppServerTurn } from './parse-app-server-turn';
import { planTurnSettlement } from './plan-turn-settlement';
import type { TurnSettlement } from './plan-turn-settlement';

export interface ThreadRecovery {
  // queued messages a stored turn holds, which the server took before they were marked
  // delivered
  readonly acks: readonly string[];
  readonly settlements: readonly TurnSettlement[];

  // delivered messages no stored turn holds
  readonly lost: readonly string[];
  readonly carried: ReadonlyMap<string, string>;
  readonly replies: ReadonlyMap<string, string>;
}

export function planThreadRecovery(
  unsettled: readonly UnsettledMessage[],
  turns: readonly AppServerTurn[],
): ThreadRecovery {
  const acks: string[] = [];
  const lost: string[] = [];

  const carriedBy = new Map<string, string[]>();

  for (const message of unsettled) {
    const turn = turns.find((t) =>
      t.items.some((i) => i.type === 'userMessage' && i.clientId === message.id),
    );

    if (turn === undefined) {
      if (message.status === 'delivered') {
        lost.push(message.id);
      }

      continue;
    }

    if (message.status === 'queued') {
      acks.push(message.id);
    }

    carriedBy.set(turn.id, [...(carriedBy.get(turn.id) ?? []), message.id]);
  }

  const settlements: TurnSettlement[] = [];

  const carried = new Map<string, string>();
  const replies = new Map<string, string>();

  for (const [turnID, messages] of carriedBy) {
    const turn = turns.find((t) => t.id === turnID);

    if (turn === undefined) {
      continue;
    }

    const reply = turn.items.findLast((i) => i.type === 'agentMessage')?.text;
    const settlement = planTurnSettlement(turn.id, turn.status, messages, reply);

    if (settlement !== null) {
      settlements.push(settlement);
      continue;
    }

    for (const message of messages) {
      carried.set(message, turn.id);
    }

    if (reply !== undefined) {
      replies.set(turn.id, reply);
    }
  }

  return { acks, settlements, lost, carried, replies };
}
