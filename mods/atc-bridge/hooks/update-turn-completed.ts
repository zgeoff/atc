import type { BridgeHost, BridgeState } from './bridge-state.ts';
import { scheduleAnsweredReport } from './schedule-answered-report.ts';
import { scheduleDelivery } from './schedule-delivery.ts';
import { scheduleNoticeReminder } from './schedule-notice-reminder.ts';
import { scheduleUnansweredReport } from './schedule-unanswered-report.ts';

export function updateTurnCompleted(
  host: BridgeHost,
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
      host,
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
      scheduleDelivery(host, state, msg);
    } else if (isAnswered) {
      answered.push(msg.id);
    } else {
      unanswered.push(msg.id);
    }
  }

  // atc records the whole group at once so no member reads as answered before the rest.
  if (answered.length > 0) {
    scheduleAnsweredReport(host, state, answered, turnID, answer);
  }

  if (unanswered.length > 0) {
    scheduleUnansweredReport(host, state, unanswered, toUnansweredReason(reason), turnID);
  }
}

function toUnansweredReason(reason: string): string {
  if (reason === 'aborted') {
    return 'interrupted';
  }

  return reason === 'refusal' ? 'refusal' : 'error';
}
