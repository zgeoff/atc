import type { SessionID } from '@atc/core';
import { DAEMON_EVENT_SCHEMA } from '@atc/protocol';
import type { DaemonEvent } from '@atc/protocol';
import { DaemonError, PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { EVENT_FEED_MACHINE } from './event-feed-machine';

interface EventFeedOptions {
  // How many bytes of events the backlog holds before the next one
  // overflows it.
  readonly capacity: number;

  // Whether the connection may see a session's output when the session's
  // dropped output is reported.
  readonly canSeeOutput: (sessionID: SessionID) => boolean;

  // Repaints a session whose output was dropped, once the backlog drains.
  readonly resync: (sessionID: SessionID) => void;

  // Runs when an event other than terminal output overflows the backlog of
  // a feed with a subscriber, which ends the connection.
  readonly onOverflow: () => void;
}

// The events one connection's subscription delivers, with the backlog the
// subscriber has not taken yet.
export interface EventFeed {
  readonly emit: (event: EventMsg) => void;
  readonly emitOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;

  // Drops a session's dropped-output record once the session leaves the
  // connection's view.
  readonly forgetSession: (sessionID: SessionID) => void;
  readonly subscribe: (signal: AbortSignal) => AsyncGenerator<DaemonEvent>;
}

interface QueuedEvent {
  readonly event: EventMsg;
  readonly bytes: number;
}

interface FeedState {
  // Whether the feed collects, has abandoned its backlog, or has a
  // subscriber.
  readonly actor: Actor<typeof EVENT_FEED_MACHINE>;
  readonly backlog: QueuedEvent[];

  // The bytes of output each session dropped since its last report.
  readonly desynced: Map<SessionID, number>;
  queuedBytes: number;
  wake: PromiseWithResolvers<void> | null;
}

// The feed collects events from the handshake on, so a subscription that
// starts after it misses none. An overflow drops a session's output and
// reports the dropped bytes with a repaint once the backlog drains.
export function createEventFeed(options: EventFeedOptions): EventFeed {
  const state: FeedState = {
    actor: createActor(EVENT_FEED_MACHINE).start(),
    backlog: [],
    desynced: new Map(),
    queuedBytes: 0,
    wake: null,
  };

  const emit = (event: EventMsg) => {
    if (isFeedIn(state, 'abandoned')) {
      return;
    }

    const bytes = JSON.stringify(event).length;

    if (hasRoom(state, options.capacity, bytes)) {
      scheduleEvent(state, event, bytes);

      return;
    }

    if (isFeedIn(state, 'subscribed')) {
      options.onOverflow();

      return;
    }

    state.actor.send({ type: 'OVERFLOW' });

    state.backlog.length = 0;
    state.queuedBytes = 0;

    state.desynced.clear();
  };

  // A chunk is never dropped without a report and a repaint, because a byte
  // stream cut mid-escape corrupts the client's terminal state.
  const emitOutput = (sessionID: SessionID, event: EventMsg, byteLength: number) => {
    if (isFeedIn(state, 'abandoned')) {
      return;
    }

    const dropped = state.desynced.get(sessionID);

    if (dropped !== undefined) {
      state.desynced.set(sessionID, dropped + byteLength);

      return;
    }

    if (hasRoom(state, options.capacity, byteLength)) {
      scheduleEvent(state, event, byteLength);

      return;
    }

    state.desynced.set(sessionID, byteLength);
  };

  // A second subscription is refused before it starts, so the refusal
  // answers the request instead of ending a stream.
  const subscribe = (signal: AbortSignal): AsyncGenerator<DaemonEvent> => {
    if (isFeedIn(state, 'subscribed')) {
      throw new DaemonError('bad_args', 'this connection already subscribes to its events');
    }

    state.actor.send({ type: 'SUBSCRIBE' });

    return drainBacklog(state, signal, () => {
      emitDesyncs(state, options, emit);
    });
  };

  return {
    emit,
    emitOutput,
    forgetSession: (sessionID) => {
      state.desynced.delete(sessionID);
    },
    subscribe,
  };
}

function isFeedIn(state: FeedState, value: 'abandoned' | 'subscribed'): boolean {
  return state.actor.getSnapshot().matches(value);
}

// A payload once started is never cut, so an empty backlog takes an event
// of any size.
function hasRoom(state: FeedState, capacity: number, bytes: number): boolean {
  return state.backlog.length === 0 || state.queuedBytes + bytes <= capacity;
}

function scheduleEvent(state: FeedState, event: EventMsg, bytes: number): void {
  state.backlog.push({ event, bytes });

  state.queuedBytes += bytes;
  state.wake?.resolve();
}

// Each session that dropped output is reported once the backlog drains,
// ahead of the repaint that resynchronizes it.
function emitDesyncs(
  state: FeedState,
  options: EventFeedOptions,
  emit: (event: EventMsg) => void,
): void {
  for (const [sessionID, dropped] of state.desynced) {
    state.desynced.delete(sessionID);

    if (options.canSeeOutput(sessionID)) {
      emit({ v: PROTOCOL_V, ev: 'SessionDesync', s: sessionID, dropped });

      options.resync(sessionID);
    }
  }
}

async function* drainBacklog(
  state: FeedState,
  signal: AbortSignal,
  onDrained: () => void,
): AsyncGenerator<DaemonEvent> {
  try {
    while (!signal.aborted) {
      const next = state.backlog.shift();

      if (next !== undefined) {
        state.queuedBytes -= next.bytes;
        yield DAEMON_EVENT_SCHEMA.parse(next.event);
        continue;
      }

      if (state.desynced.size > 0) {
        onDrained();
        continue;
      }

      await waitForEvent(state, signal);
    }
  } finally {
    state.actor.send({ type: 'UNSUBSCRIBE' });
  }
}

async function waitForEvent(state: FeedState, signal: AbortSignal): Promise<void> {
  const woken = Promise.withResolvers<void>();

  const onAbort = () => {
    woken.resolve();
  };

  state.wake = woken;

  signal.addEventListener('abort', onAbort, { once: true });

  await woken.promise;

  signal.removeEventListener('abort', onAbort);

  state.wake = null;
}
