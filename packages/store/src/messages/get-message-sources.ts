import type { MessageStatus } from './message-record';

const MESSAGE_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ['delivered', 'answered', 'unanswered'],
  delivered: ['answered', 'unanswered'],
  answered: [],
  unanswered: [],
};

export function getMessageSources(
  to: MessageStatus,
  within?: readonly MessageStatus[],
): MessageStatus[] {
  const sources = Object.keys(MESSAGE_TRANSITIONS)
    .filter((from) => isMessageStatus(from))
    .filter((from) => MESSAGE_TRANSITIONS[from].includes(to));

  if (within === undefined) {
    return sources;
  }

  const refused = within.filter((from) => !sources.includes(from));

  if (refused.length > 0) {
    throw new Error(`a message cannot move from ${refused.join(', ')} to ${to}`);
  }

  return [...within];
}

function isMessageStatus(value: string): value is MessageStatus {
  return Object.hasOwn(MESSAGE_TRANSITIONS, value);
}
