import type { MessageBridgeHost } from '@atc/plugin-api';
import type { TurnSettlement } from './plan-turn-settlement';

export async function applyTurnSettlement(
  host: MessageBridgeHost,
  settlement: TurnSettlement,
): Promise<void> {
  const payload =
    settlement.kind === 'answered'
      ? {
          kind: 'answered',
          messages: settlement.messages,
          answer: settlement.answer,
          turn: settlement.turn,
        }
      : {
          kind: 'unanswered',
          messages: settlement.messages,
          reason: settlement.reason,
          turn: settlement.turn,
        };

  await host.applyNote(payload);
}
