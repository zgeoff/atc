import type { MessageSender } from '@atc/protocol/wire';

interface MessageLineFields {
  readonly message: string;
  readonly from: string;
  readonly sender?: MessageSender | undefined;
  readonly text: string;
  readonly sentAt: number;
}

export function renderMessageLine(msg: MessageLineFields): string {
  return `${JSON.stringify({
    id: msg.message,
    from: msg.from,

    // the sender's kind stays inside `sender`: a reader takes a line with a
    // top-level `kind` for an answer notice
    ...(msg.sender === undefined ? {} : { sender: msg.sender }),
    text: msg.text,
    sentAt: msg.sentAt,
  })}\n`;
}
