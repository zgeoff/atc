import type { EngineInterface } from 'claude-code';
import type { BridgeState } from './bridge-state.ts';
import type { TapMessage, TapNotice, TapSender } from './parse-tap-line.ts';
import { scheduleUnansweredReport } from './report-turns.ts';

export function scheduleDelivery($: EngineInterface, state: BridgeState, msg: TapMessage): void {
  state.delivering = state.delivering
    .then(() => sendMessage($, state, msg))
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: delivering ${msg.id} failed (${String(error)})`, { to: 'debug' });
    });
}

async function sendMessage($: EngineInterface, state: BridgeState, msg: TapMessage): Promise<void> {
  await waitForStepEnd(state);

  const turnID = state.runningTurnID;

  if (turnID !== null && (await tryUpdateConversation($, msg.id, renderEnvelope(msg)))) {
    const carried = state.carried.get(turnID);

    // The append can resolve after the turn completed; the turn then no
    // longer reports or redelivers anything, so the message goes out as a
    // fresh submit instead.
    if (carried !== undefined && state.runningTurnID === turnID) {
      carried.push(msg);
      state.unseen.add(msg.id);

      return;
    }
  }

  state.awaitingTurn.set(msg.id, msg);

  const submitted = await $.prompt.submit({ text: renderEnvelope(msg) });

  if ('drop' in submitted && submitted.drop !== undefined) {
    state.awaitingTurn.delete(msg.id);
    $.ui.log(`atc-bridge: a hook dropped ${msg.id} (${submitted.drop})`, { to: 'debug' });

    scheduleUnansweredReport($, state, [msg.id], 'not_started', null);
  }
}

// A hold that ends lets the next delivery go, which a step that starts at once
// can hold again.
async function waitForStepEnd(state: BridgeState): Promise<void> {
  while (state.stepHold !== null) {
    await state.stepHold.ended;
  }
}

async function tryUpdateConversation(
  $: EngineInterface,
  id: string,
  text: string,
): Promise<boolean> {
  try {
    const appended = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
    });

    return appended.deny === undefined;
  } catch (error) {
    $.ui.log(`atc-bridge: appending ${id} failed (${String(error)}); submitting it instead`, {
      to: 'debug',
    });

    return false;
  }
}

function renderEnvelope(msg: TapMessage): string {
  const body = msg.text.replaceAll('</atc-message>', '&lt;/atc-message&gt;');

  return `<atc-message id="${encodeAttribute(msg.id)}" from="${encodeAttribute(msg.from)}"${renderSenderAttributes(msg.sender)}>\n${body}\n</atc-message>`;
}

function renderSenderAttributes(sender: TapSender | undefined): string {
  if (sender === undefined) {
    return '';
  }

  const session =
    sender.session === undefined ? '' : ` session="${encodeAttribute(sender.session)}"`;

  return ` kind="${sender.kind}"${session}`;
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function scheduleNoticeDelivery(
  $: EngineInterface,
  state: BridgeState,
  notice: TapNotice,
): void {
  state.delivering = state.delivering
    .then(() => sendNotice($, state, notice))
    .catch((error: unknown) => {
      $.ui.log(
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
async function sendNotice(
  $: EngineInterface,
  state: BridgeState,
  notice: TapNotice,
): Promise<void> {
  if (state.shownNotices.has(notice.id)) {
    return;
  }

  await waitForStepEnd(state);

  const turnID = state.runningTurnID;
  const text = renderAnswerNotice(notice);

  if (turnID !== null && (await tryUpdateConversation($, notice.id, text))) {
    state.shownNotices.add(notice.id);

    const unseen = state.unseenNotices.get(turnID);

    if (unseen !== undefined && state.runningTurnID === turnID) {
      unseen.push(notice);
    } else {
      scheduleNoticeReminder($, state, [notice.id]);
    }

    return;
  }

  const submitted = await $.prompt.submit({ text });

  if ('drop' in submitted && submitted.drop !== undefined) {
    $.ui.log(`atc-bridge: a hook dropped the answer notice for ${notice.id} (${submitted.drop})`, {
      to: 'debug',
    });

    return;
  }

  state.shownNotices.add(notice.id);
}

// A prompt that wakes the model for notices already in its conversation,
// which names them without repeating them.
export function scheduleNoticeReminder(
  $: EngineInterface,
  state: BridgeState,
  messageIDs: readonly string[],
): void {
  const text = renderNoticeReminder(messageIDs);

  state.delivering = state.delivering
    .then(async () => {
      const submitted = await $.prompt.submit({ text });

      if ('drop' in submitted && submitted.drop !== undefined) {
        $.ui.log(`atc-bridge: a hook dropped the reminder for ${messageIDs.join(', ')}`, {
          to: 'debug',
        });
      }
    })
    .catch((error: unknown) => {
      $.ui.log(
        `atc-bridge: reminding of the answer notices for ${messageIDs.join(', ')} failed (${String(error)})`,
        { to: 'debug' },
      );
    });
}

function renderNoticeReminder(messageIDs: readonly string[]): string {
  const subject =
    messageIDs.length === 1
      ? `the answer notice for ${messageIDs.join('')}`
      : `the answer notices for ${messageIDs.join(', ')}`;

  return `atc added ${subject} to this conversation after your last reply. Read ${messageIDs.length === 1 ? 'it' : 'them'} above; atc does not send ${messageIDs.length === 1 ? 'it' : 'them'} again.`;
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
