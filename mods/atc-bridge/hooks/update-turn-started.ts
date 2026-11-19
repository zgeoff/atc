import type { BridgeState } from './bridge-state.ts';
import type { TapMessage } from './parse-tap-line.ts';

const ENVELOPE_ID = /<atc-message id="(?<id>[^"]+)"/gu;

export function updateTurnStarted(state: BridgeState, turnID: string, text: string): void {
  const carried: TapMessage[] = [];

  state.runningTurnID = turnID;

  state.carried.set(turnID, carried);
  state.unseenNotices.set(turnID, []);

  for (const match of text.matchAll(ENVELOPE_ID)) {
    const msg = state.awaitingTurn.get(match.groups?.['id'] ?? '');

    if (msg !== undefined) {
      state.awaitingTurn.delete(msg.id);
      carried.push(msg);
    }
  }
}
