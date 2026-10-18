import type { MessageStatus } from './message-record';

// The moves a message's status may make, which every status write in the store follows. A tap's
// ack delivers a queued message, a turn settles a queued or delivered one once, and a restore puts
// a delivered one back to queued for the revived process. A settled message never moves again.
const MESSAGE_TRANSITIONS: Readonly<Record<MessageStatus, readonly MessageStatus[]>> = {
  queued: ['delivered', 'answered', 'unanswered'],
  delivered: ['queued', 'answered', 'unanswered'],
  answered: [],
  unanswered: [],
};

// The statuses a write that moves messages to the given status may match, narrowed to the ones a
// write names when it takes only some. Throws when a named status may not make the move.
export function getMessageSources(
  to: MessageStatus,
  within?: readonly MessageStatus[],
): MessageStatus[] {
  const sources = (Object.keys(MESSAGE_TRANSITIONS) as MessageStatus[]).filter((from) =>
    MESSAGE_TRANSITIONS[from].includes(to),
  );

  if (within === undefined) {
    return sources;
  }

  const refused = within.filter((from) => !sources.includes(from));

  if (refused.length > 0) {
    throw new Error(`a message cannot move from ${refused.join(', ')} to ${to}`);
  }

  return [...within];
}
