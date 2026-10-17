import type { BridgedNotice } from '@atc/plugin-api';
import type { AppServerConnection } from './app-server-connection';
import { buildModelParams } from './build-model-params';
import { isOverload } from './is-overload';
import { isRefusal } from './is-refusal';
import { NOTICE_PREFIX } from './notice-prefix';
import { renderAtcAnswer } from './render-atc-answer';
import type { TurnSendContext } from './turn-send-context';

export interface NoticeSend {
  readonly conn: AppServerConnection;
  readonly thread: string | null;
  readonly notice: BridgedNotice;

  // sends the notice again once an overload wait ends, checking the bridge's state anew
  readonly resend: () => Promise<void>;
}

export async function sendBridgedNotice(context: TurnSendContext, send: NoticeSend): Promise<void> {
  try {
    await send.conn.sendRequest('turn/start', {
      threadId: send.thread,
      input: [{ type: 'text', text: renderAtcAnswer(send.notice), text_elements: [] }],
      clientUserMessageId: `${NOTICE_PREFIX}${send.notice.id}`,
      ...buildModelParams(context.model),
    });
  } catch (error) {
    if (isOverload(error)) {
      context.host.log(
        `codex app server: the App Server is overloaded; notice ${send.notice.id} stayed queued (${error.message})`,
      );

      const again = await context.waitOutOverload(send.conn);

      if (again) {
        await send.resend();
      }

      return;
    }

    // A notice the server refused is taken all the same, so it holds up
    // no later item of the inbox.
    if (isRefusal(error)) {
      context.host.log(
        `codex app server: the App Server refused notice ${send.notice.id} (${error.message})`,
      );

      await context.host.ackNotice(send.notice.id);

      return;
    }

    context.host.log(`codex app server: notice ${send.notice.id} stayed queued (${String(error)})`);
    context.dropConnection(send.conn);

    return;
  }

  context.resetOverload();

  await context.host.ackNotice(send.notice.id);
}
