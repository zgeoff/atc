import type { MessageSender } from '@atcx/contract/light';

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

    ...(message.sender === undefined ? {} : { sender: message.sender }),
    text: message.text,
    sentAt: message.sentAt,
  })}\n`;
}
