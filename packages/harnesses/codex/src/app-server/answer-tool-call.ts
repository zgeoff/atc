import type { MessageBridgeHost } from '@atc/plugin-api';
import { z } from 'zod';
import type { AppServerConnection, AppServerRequest } from './app-server-connection';
import { NOTE_LABELS } from './note-labels';

export interface ToolCallAnswer {
  readonly conn: AppServerConnection;
  readonly request: AppServerRequest;

  // the thread the bridge serves
  readonly threadID: string | null;

  // the turn that carries each message the bridge tracks, until it settles
  readonly carried: Map<string, string>;
  readonly host: MessageBridgeHost;
}

const TOOL_CALL_SCHEMA = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// Serves a call to one of the bridge's own tools on its thread; every
// other server request, approvals among them, is left to the terminal.
export async function answerToolCall(answer: ToolCallAnswer): Promise<void> {
  if (answer.request.method !== 'item/tool/call') {
    return;
  }

  const call = TOOL_CALL_SCHEMA.safeParse(answer.request.params);

  if (!call.success || call.data.threadId !== answer.threadID) {
    return;
  }

  const args = call.data.arguments ?? {};
  const text = typeof args['text'] === 'string' ? args['text'].trim() : '';

  const sendRefusal = (reason: string) => {
    answer.conn.sendResult(answer.request.id, {
      success: false,
      contentItems: [{ type: 'inputText', text: reason }],
    });
  };

  if (text === '') {
    sendRefusal(`${call.data.tool} needs non-empty text`);

    return;
  }

  if (call.data.tool === 'note') {
    const label = typeof args['label'] === 'string' ? args['label'] : 'progress';

    if (!NOTE_LABELS.some((candidate) => candidate === label)) {
      sendRefusal(`note label must be ${NOTE_LABELS.join(', ')}`);

      return;
    }

    await answer.host.applyNote({ kind: 'note', label, text });

    answer.conn.sendResult(answer.request.id, {
      success: true,
      contentItems: [{ type: 'inputText', text: 'Handed to atc for its event feed.' }],
    });

    return;
  }

  if (call.data.tool !== 'answer') {
    return;
  }

  const message = typeof args['message'] === 'string' ? args['message'] : '';

  if (answer.carried.get(message) !== call.data.turnId) {
    sendRefusal(`the running turn carries no message ${message}`);

    return;
  }

  answer.carried.delete(message);

  await answer.host.applyNote({
    kind: 'answered',
    message,
    answer: text,
    turn: call.data.turnId,
  });

  answer.conn.sendResult(answer.request.id, {
    success: true,
    contentItems: [{ type: 'inputText', text: `Handed to atc as the answer to ${message}.` }],
  });
}
