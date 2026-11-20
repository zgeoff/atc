import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { DaemonEvent, SessionID } from '@atcx/contract';
import { DAEMON_EVENT_SCHEMA } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { EVENT_FEED_MACHINE } from './event-feed-machine';
import { findEventSession } from './find-event-session';

interface EventFeedOptions {
  readonly capacity: number;

  readonly canSeeOutput: (sessionID: SessionID) => boolean;

  readonly resync: (sessionID: SessionID) => void;

  readonly onOverflow: () => void;
}

export interface EventFeed {
  readonly emit: (event: EventMsg) => void;
  readonly emitOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;

  readonly forgetSession: (sessionID: SessionID) => void;
  readonly subscribe: (signal: AbortSignal) => AsyncGenerator<DaemonEvent>;
}

interface QueuedEvent {
  readonly event: EventMsg;
  readonly bytes: number;
}

interface FeedState {
  readonly actor: Actor<typeof EVENT_FEED_MACHINE>;
  readonly backlog: QueuedEvent[];

  readonly desynced: Map<SessionID, number>;
  queuedBytes: number;
  wake: PromiseWithResolvers<void> | null;
}

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

  // Cutting a byte stream mid-escape corrupts the client's terminal state, so a dropped chunk
  // always gets a report and a repaint.
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

  const subscribe = (signal: AbortSignal): AsyncGenerator<DaemonEvent> => {
    if (isFeedIn(state, 'subscribed')) {
      throw new AtcError('bad_args', 'this connection already subscribes to its events');
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

      dropSessionBacklog(state, sessionID);
    },
    subscribe,
  };
}

function isFeedIn(state: FeedState, value: 'abandoned' | 'subscribed'): boolean {
  return state.actor.getSnapshot().matches(value);
}

function hasRoom(state: FeedState, capacity: number, bytes: number): boolean {
  return state.backlog.length === 0 || state.queuedBytes + bytes <= capacity;
}

function scheduleEvent(state: FeedState, event: EventMsg, bytes: number): void {
  state.backlog.push({ event, bytes });

  state.queuedBytes += bytes;
  state.wake?.resolve();
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

function emitDesyncs(
  state: FeedState,
  options: EventFeedOptions,
  emit: (event: EventMsg) => void,
): void {
  for (const [sessionID, dropped] of state.desynced) {
    state.desynced.delete(sessionID);

    if (options.canSeeOutput(sessionID)) {
      emit({ version: PROTOCOL_V, ev: 'SessionDesync', sessionID, dropped });

      options.resync(sessionID);
    }
  }
}

function dropSessionBacklog(state: FeedState, sessionID: SessionID): void {
  const kept = state.backlog.filter((queued) => findEventSession(queued.event) !== sessionID);

  state.backlog.length = 0;

  state.backlog.push(...kept);

  state.queuedBytes = kept.reduce((total, queued) => total + queued.bytes, 0);
}
