import type { MessageBridgeHost } from '@atc/plugin-api';
import { applyTurnSettlement } from './apply-turn-settlement';
import type { ThreadRecovery } from './plan-thread-recovery';

export interface ThreadRecoveryApply {
  readonly recovery: ThreadRecovery;

  readonly carried: Map<string, string>;

  readonly replies: Map<string, string>;
  readonly settledTurns: Set<string>;
  readonly host: MessageBridgeHost;
}

export async function applyThreadRecovery(apply: ThreadRecoveryApply): Promise<void> {
  for (const id of apply.recovery.acks) {
    await apply.host.ackMessage(id);
  }

  for (const settlement of apply.recovery.settlements) {
    apply.settledTurns.add(settlement.turn);

    await applyTurnSettlement(apply.host, settlement);
  }

  if (apply.recovery.lost.length > 0) {
    await apply.host.applyNote({
      kind: 'unanswered',
      messages: apply.recovery.lost,
      reason: 'not_started',
    });
  }

  for (const [message, turn] of apply.recovery.carried) {
    apply.carried.set(message, turn);
  }

  for (const [turn, reply] of apply.recovery.replies) {
    apply.replies.set(turn, reply);
  }
}
