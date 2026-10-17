import type { MessageBridgeHost } from '@atc/plugin-api';
import { applyTurnSettlement } from './apply-turn-settlement';
import type { AppServerTurn } from './parse-app-server-turn';
import { planTurnSettlement } from './plan-turn-settlement';

export interface CompletedTurn {
  readonly turn: AppServerTurn;

  // the turn that carries each message the bridge tracks, until it settles
  readonly carried: Map<string, string>;

  // the last reply each tracked turn has given so far
  readonly replies: Map<string, string>;
  readonly settledTurns: Set<string>;
  readonly host: MessageBridgeHost;
}

export async function applyTurnCompleted(completed: CompletedTurn): Promise<void> {
  if (completed.settledTurns.has(completed.turn.id)) {
    return;
  }

  completed.settledTurns.add(completed.turn.id);

  const messages = [...completed.carried]
    .filter(([, t]) => t === completed.turn.id)
    .map(([m]) => m);

  const reply =
    completed.replies.get(completed.turn.id) ??
    completed.turn.items.findLast((i) => i.type === 'agentMessage')?.text;

  for (const message of messages) {
    completed.carried.delete(message);
  }

  completed.replies.delete(completed.turn.id);

  const settlement = planTurnSettlement(completed.turn.id, completed.turn.status, messages, reply);

  if (settlement !== null) {
    await applyTurnSettlement(completed.host, settlement);
  }
}
