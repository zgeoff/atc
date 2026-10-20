import type { MessageSender } from '@atc/protocol/wire';

interface MessageLineFields {
  readonly message: string;
  readonly from: string;
  readonly sender?: MessageSender | undefined;
  readonly text: string;
  readonly sentAt: number;
}

export function renderMessageLine(message: MessageLineFields): string {
  return `${JSON.stringify({
    id: message.message,
    from: message.from,

    // the sender's kind stays inside `sender`: a reader takes a line with a
    // top-level `kind` for an answer notice
    ...(message.sender === undefined ? {} : { sender: message.sender }),
    text: message.text,
    sentAt: message.sentAt,
  })}\n`;
}
