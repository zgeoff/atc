import type { MessageBridgeHost } from '@atc/plugin-api';
import { applyTurnSettlement } from './apply-turn-settlement';
import type { LeftThreadRecovery } from './plan-left-thread-recovery';

export async function applyLeftThreadRecovery(
  host: MessageBridgeHost,
  recovery: LeftThreadRecovery,
): Promise<void> {
  for (const id of recovery.acks) {
    await host.ackMessage(id);
  }

  for (const settlement of recovery.settlements) {
    await applyTurnSettlement(host, settlement);
  }

  if (recovery.stranded.length > 0) {
    await host.applyNote({
      kind: 'unanswered',
      messages: recovery.stranded,
      reason: 'thread_switched',
    });
  }
}
