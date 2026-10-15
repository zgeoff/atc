import type { MessageSender } from '@atc/protocol/wire';

/**
 * The fields of one inbox message a tap prints: its id, its sender's name,
 * who sent it when the daemon typed its sender, its text, and when it was
 * sent.
 */
interface MessageLineFields {
  readonly message: string;
  readonly from: string;
  readonly sender?: MessageSender | undefined;
  readonly text: string;
  readonly sentAt: number;
}

/**
 * The NDJSON line a tap prints for one inbox message. The sender's kind sits
 * inside `sender`, never at the top: a reader takes a line with a top-level
 * `kind` for an answer notice.
 */
export function renderMessageLine(msg: MessageLineFields): string {
  return `${JSON.stringify({
    id: msg.message,
    from: msg.from,
    ...(msg.sender === undefined ? {} : { sender: msg.sender }),
    text: msg.text,
    sentAt: msg.sentAt,
  })}\n`;
}
