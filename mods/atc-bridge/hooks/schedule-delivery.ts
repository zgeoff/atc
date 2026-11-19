import type { BridgeHost, BridgeState } from './bridge-state.ts';
import { encodeAttribute } from './encode-attribute.ts';
import type { TapMessage, TapSender } from './parse-tap-line.ts';
import { scheduleUnansweredReport } from './schedule-unanswered-report.ts';
import { tryUpdateConversation } from './try-update-conversation.ts';
import { waitForStepEnd } from './wait-for-step-end.ts';

export function scheduleDelivery(host: BridgeHost, state: BridgeState, msg: TapMessage): void {
  state.delivering = state.delivering
    .then(() => sendMessage(host, state, msg))
    .catch((error: unknown) => {
      host.ui.log(`atc-bridge: delivering ${msg.id} failed (${String(error)})`, { to: 'debug' });
    });
}

async function sendMessage(host: BridgeHost, state: BridgeState, msg: TapMessage): Promise<void> {
  await waitForStepEnd(state);

  const turnID = state.runningTurnID;

  if (turnID !== null && (await tryUpdateConversation(host, msg.id, renderEnvelope(msg)))) {
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

  const submitted = await host.prompt.submit({ text: renderEnvelope(msg) });

  if ('drop' in submitted && submitted.drop !== undefined) {
    state.awaitingTurn.delete(msg.id);
    host.ui.log(`atc-bridge: a hook dropped ${msg.id} (${submitted.drop})`, { to: 'debug' });

    scheduleUnansweredReport(host, state, [msg.id], 'not_started', null);
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
