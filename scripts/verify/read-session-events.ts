import { WringerError } from '@wringer/core';
import type { StreamClient } from '@wringer/stream';
import { collectSessionEvents } from './collect-session-events.ts';
import type { SessionEvent } from './collect-session-events.ts';
import { findLifecycleGap } from './find-lifecycle-gap.ts';
import { readStreamLines } from './read-stream-lines.ts';

// The exit line can reach the stream after the kill answers, so a read waits this long for it.
const SETTLE_MS = 5000;

export async function readSessionEvents(
  client: StreamClient,
  name: string,
): Promise<{ events: SessionEvent[] }> {
  const deadline = Date.now() + SETTLE_MS;

  for (;;) {
    const lines = await readStreamLines(client, 'events');

    const events = collectSessionEvents(lines, name);
    const gap = findLifecycleGap(events);

    if (gap === null) {
      return { events };
    }

    if (Date.now() >= deadline) {
      throw new WringerError('check-failed', {
        message: `the events of ${name} lack ${gap}; they are ${JSON.stringify(events)}`,
      });
    }

    await Bun.sleep(200);
  }
}
