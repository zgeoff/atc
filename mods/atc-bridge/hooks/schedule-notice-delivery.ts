import type { BridgeHost, BridgeState } from './bridge-state.ts';
import { encodeAttribute } from './encode-attribute.ts';
import type { TapNotice } from './parse-tap-line.ts';
import { scheduleNoticeReminder } from './schedule-notice-reminder.ts';
import { tryUpdateConversation } from './try-update-conversation.ts';
import { waitForStepEnd } from './wait-for-step-end.ts';

export function scheduleNoticeDelivery(
  host: BridgeHost,
  state: BridgeState,
  notice: TapNotice,
): void {
  state.delivering = state.delivering
    .then(() => sendNotice(host, state, notice))
    .catch((error: unknown) => {
      host.ui.log(
        `atc-bridge: delivering the answer notice for ${notice.id} failed (${String(error)})`,
        {
          to: 'debug',
        },
      );
    });
}

// A notice never waits for a turn to start and never joins one's carried
// messages, so no turn reports an answer for it. An appended notice stays in
// the conversation, so it is never sent again; a turn that ends before a step
// shows it leaves a reminder that names it instead.
async function sendNotice(host: BridgeHost, state: BridgeState, notice: TapNotice): Promise<void> {
  if (state.shownNotices.has(notice.id)) {
    return;
  }

  await waitForStepEnd(state);

  const turnID = state.runningTurnID;
  const text = renderAnswerNotice(notice);

  if (turnID !== null && (await tryUpdateConversation(host, notice.id, text))) {
    state.shownNotices.add(notice.id);

    const unseen = state.unseenNotices.get(turnID);

    if (unseen !== undefined && state.runningTurnID === turnID) {
      unseen.push(notice);
    } else {
      scheduleNoticeReminder(host, state, [notice.id]);
    }

    return;
  }

  const submitted = await host.prompt.submit({ text });

  if ('drop' in submitted && submitted.drop !== undefined) {
    host.ui.log(
      `atc-bridge: a hook dropped the answer notice for ${notice.id} (${submitted.drop})`,
      {
        to: 'debug',
      },
    );

    return;
  }

  state.shownNotices.add(notice.id);
}

function renderAnswerNotice(notice: TapNotice): string {
  const reason =
    notice.status === 'unanswered' && notice.reason !== undefined
      ? ` reason="${encodeAttribute(notice.reason)}"`
      : '';

  const body = (notice.answer ?? renderNoticeAdvice(notice)).replaceAll(
    '</atc-answer>',
    '&lt;/atc-answer&gt;',
  );

  return `<atc-answer id="${encodeAttribute(notice.id)}" from="${encodeAttribute(notice.from)}" status="${encodeAttribute(notice.status)}"${reason}>\n${body}\n</atc-answer>`;
}

// A message whose session ended before it answered reaches no one unless
// its sender sends it again, so the notice says so.
function renderNoticeAdvice(notice: TapNotice): string {
  return notice.status === 'unanswered' && notice.reason === 'session_ended'
    ? 'This message has no answer, because its session ended before it answered. Send it again if you still need the answer.'
    : '';
}
