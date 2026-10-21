import type { BridgedMessage } from '@atc/plugin-api';
import { z } from 'zod';
import { buildModelParams } from './build-model-params';
import type { AppServerConnection } from './create-app-server-connection';
import { isOverload } from './is-overload';
import { isRefusal } from './is-refusal';
import { renderAtcEnvelope } from './render-atc-envelope';
import type { TurnSendContext } from './turn-send-context';

export interface MessageSend {
  readonly conn: AppServerConnection;
  readonly thread: string;
  readonly message: BridgedMessage;

  // sends the message again once an overload wait ends, checking the bridge's state anew
  readonly resend: () => Promise<void>;
}

const TURN_RESULT_SCHEMA = z.looseObject({ turn: z.looseObject({ id: z.string() }) });

// A message that fails to send stays queued: the connection drops, and
// the next one recovers before the tap hands the message over again.
export async function sendBridgedMessage(
  context: TurnSendContext,
  send: MessageSend,
): Promise<void> {
  let turnID: string;

  try {
    const result = await send.conn.sendRequest('turn/start', {
      threadId: send.thread,
      input: [{ type: 'text', text: renderAtcEnvelope(send.message), text_elements: [] }],
      clientUserMessageId: send.message.id,
      ...buildModelParams(context.model),
    });

    const started = TURN_RESULT_SCHEMA.parse(result);

    turnID = started.turn.id;
  } catch (error) {
    if (isOverload(error)) {
      context.host.log(
        `codex app server: the App Server is overloaded; message ${send.message.id} stayed queued (${error.message})`,
      );

      const again = await context.waitOutOverload(send.conn);

      if (again) {
        await send.resend();
      }

      return;
    }

    // An error the server answered shows it refused the message, and a
    // resend would meet the same refusal, so the message ends unanswered.
    if (isRefusal(error)) {
      context.host.log(
        `codex app server: the App Server refused message ${send.message.id} (${error.message})`,
      );

      await context.host.applyNote({
        kind: 'unanswered',
        messages: [send.message.id],
        reason: 'error',
      });

      return;
    }

    context.host.log(
      `codex app server: message ${send.message.id} stayed queued (${String(error)})`,
    );

    context.unconfirmed.setThread(send.message.id, send.thread);
    context.dropConnection(send.conn);

    return;
  }

  context.resetOverload();
  context.carryMessage(send.message.id, turnID);

  await context.host.ackMessage(send.message.id);
}
