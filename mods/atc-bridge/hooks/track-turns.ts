import type { EngineInterface } from 'claude-code';
import type { BridgeState } from './bridge-state.ts';
import { scheduleDelivery, scheduleNoticeReminder } from './deliver-messages.ts';
import type { TapMessage } from './parse-tap-line.ts';
import { scheduleAnsweredReport, scheduleUnansweredReport } from './report-turns.ts';

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

export function updateTurnCompleted(
  $: EngineInterface,
  state: BridgeState,
  turnID: string,
  answer: string,
  reason: string,
): void {
  const carried = state.carried.get(turnID) ?? [];

  state.carried.delete(turnID);

  const unseenNotices = state.unseenNotices.get(turnID) ?? [];

  if (unseenNotices.length > 0) {
    scheduleNoticeReminder(
      $,
      state,
      unseenNotices.map((notice) => notice.id),
    );
  }

  state.unseenNotices.delete(turnID);

  if (state.runningTurnID === turnID) {
    state.runningTurnID = null;
  }

  const isAnswered = reason === 'answer';
  const answered: string[] = [];
  const unanswered: string[] = [];

  for (const msg of carried) {
    if (state.unseen.delete(msg.id)) {
      scheduleDelivery($, state, msg);
    } else if (isAnswered) {
      answered.push(msg.id);
    } else {
      unanswered.push(msg.id);
    }
  }

  // One answer carries every message the turn answered, so atc records the
  // whole group at once and no member reads as answered before the rest.
  if (answered.length > 0) {
    scheduleAnsweredReport($, state, answered, turnID, answer);
  }

  if (unanswered.length > 0) {
    scheduleUnansweredReport($, state, unanswered, toUnansweredReason(reason), turnID);
  }
}

function toUnansweredReason(reason: string): string {
  if (reason === 'aborted') {
    return 'interrupted';
  }

  return reason === 'refusal' ? 'refusal' : 'error';
}
