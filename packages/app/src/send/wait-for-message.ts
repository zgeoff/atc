import type { Clock } from '@atc/core';
import { MESSAGE_VIEW_SCHEMA } from '@atcx/contract';
import type { MessageView, SendConnection } from './types';

// The longest one read holds its request open.
const SLICE_MS = 30_000;

// How long past its wait a read gets to answer.
const ANSWER_GRACE_MS = 10_000;

interface MessageWait {
  readonly connection: Pick<SendConnection, 'request'>;
  readonly clock: Clock;
  readonly message: string;

  // How long to wait for an answer, or null to read once without waiting.
  readonly timeoutSeconds: number | null;
}

interface MessageRead {
  readonly view: MessageView;
  readonly timedOut: boolean;
}

// Throws what a read throws.
export async function waitForMessage(wait: Readonly<MessageWait>): Promise<MessageRead> {
  const read = async (waitMs: number): Promise<MessageView> => {
    const answer = await wait.connection.request(
      'message.get',
      { message: wait.message, waitMs },
      waitMs + ANSWER_GRACE_MS,
    );

    return MESSAGE_VIEW_SCHEMA.parse(answer);
  };

  if (wait.timeoutSeconds === null) {
    return { view: await read(0), timedOut: false };
  }

  const deadlineMs = wait.clock.now() + wait.timeoutSeconds * 1000;

  for (;;) {
    const view = await read(Math.min(SLICE_MS, deadlineMs - wait.clock.now()));

    if (view.status === 'answered' || view.status === 'unanswered') {
      return { view, timedOut: false };
    }

    if (deadlineMs - wait.clock.now() <= 0) {
      return { view, timedOut: true };
    }
  }
}
