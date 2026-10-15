import type { UnsettledMessage } from '@atc/plugin-api';
import type { AppServerTurn } from './parse-app-server-turn';
import { planTurnSettlement } from './plan-turn-settlement';
import type { TurnSettlement } from './plan-turn-settlement';

/**
 * What the thread's stored turns show about the session's unsettled
 * messages. `acks` holds each queued message a turn holds, which the
 * server took before the daemon marked it delivered. `settlements` holds
 * each ended turn's outcome for the messages it carried. `lost` holds each
 * delivered message no turn holds. `carried` matches each message of a turn
 * still in progress to that turn, and `replies` each such turn to its last
 * reply so far.
 */
export interface ThreadRecovery {
  readonly acks: readonly string[];
  readonly settlements: readonly TurnSettlement[];
  readonly lost: readonly string[];
  readonly carried: ReadonlyMap<string, string>;
  readonly replies: ReadonlyMap<string, string>;
}

/**
 * Plans the recovery of the session's unsettled messages from the thread's
 * stored turns. A message's turn is the turn whose user message holds the
 * message's id as its client id. A queued message no turn holds stays
 * queued, for delivery to send.
 */
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
