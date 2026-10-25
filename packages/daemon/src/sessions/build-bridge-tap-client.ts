import type { MessageBridgeTap } from '@atc/plugin-api';
import type { EventMsg } from '@atc/protocol/wire';
import { MESSAGE_SENDER_SCHEMA } from '@atcx/contract/light';
import { z } from 'zod';
import type { TapClient } from '../daemon-context';

const INBOX_MESSAGE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),
  sender: MESSAGE_SENDER_SCHEMA.optional(),
  text: z.string(),
});

const INBOX_NOTICE_SCHEMA = z.looseObject({
  message: z.string(),
  from: z.string(),
  status: z.enum(['answered', 'unanswered']),
  answer: z.string().optional(),
  reason: z.string().optional(),
});

export function buildBridgeTapClient(tap: MessageBridgeTap): TapClient {
  return {
    sendEvent: (event: EventMsg) => {
      if (event.ev === 'InboxMessage') {
        const parsed = INBOX_MESSAGE_SCHEMA.safeParse(event);

        if (parsed.success) {
          tap.takeMessage({
            id: parsed.data.message,
            from: parsed.data.from,
            ...(parsed.data.sender === undefined ? {} : { sender: parsed.data.sender }),
            text: parsed.data.text,
          });
        }

        return;
      }

      if (event.ev === 'InboxNotice') {
        const parsed = INBOX_NOTICE_SCHEMA.safeParse(event);

        if (parsed.success) {
          tap.takeNotice({
            id: parsed.data.message,
            from: parsed.data.from,
            status: parsed.data.status,
            ...(parsed.data.answer === undefined ? {} : { answer: parsed.data.answer }),
            ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
          });
        }

        return;
      }

      if (event.ev === 'InboxClosed') {
        tap.close();
      }
    },
  };
}
