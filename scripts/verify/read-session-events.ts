import { WringerError } from '@wringer/core';
import type { StreamClient } from '@wringer/stream';
import { collectSessionEvents } from './collect-session-events.ts';
import type { SessionEvent } from './collect-session-events.ts';
import { findLifecycleGap } from './find-lifecycle-gap.ts';

// The exit line can reach the stream after the kill answers, so a read waits this long for it.
const SETTLE_MS = 5000;

// Reads what `atc events` printed since `use` last marked the stream, until the session with the
// name was added, changed state and exited, in order, and fails with `check-failed` when it was
// not within the settle time.
export async function readSessionEvents(
  client: StreamClient,
  name: string,
): Promise<{ events: SessionEvent[] }> {
  const deadline = Date.now() + SETTLE_MS;

  for (;;) {
    const lines = await readStreamLines(client);

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

async function readStreamLines(client: StreamClient): Promise<string[]> {
  const lines: string[] = [];
  let from: number | undefined;

  for (;;) {
    const slice = await client.read({ name: 'events', ...(from === undefined ? {} : { from }) });

    lines.push(...slice.records.map((record) => record.line));

    if (!slice.more) {
      return lines;
    }

    from = slice.cursor;
  }
}
