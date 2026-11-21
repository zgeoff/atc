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
  readonly sendingReplays: Set<SessionID>;
  queuedBytes: number;
  wake: PromiseWithResolvers<void> | null;
}

export function createEventFeed(options: EventFeedOptions): EventFeed {
  const state: FeedState = {
    actor: createActor(EVENT_FEED_MACHINE).start(),
    backlog: [],
    desynced: new Map(),
    sendingReplays: new Set(),
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
    state.sendingReplays.clear();
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

    // A replay is the whole screen, sent in one burst after a drain or on attach, and a client
    // shows none of it before its last chunk, so it enters whole and outside the output budget.
    // A newer replay covers an older one, so the queue holds at most one per session unsent.
    if (event.ev === 'SessionReplay') {
      if (!isReplayOpen(state.backlog, sessionID)) {
        replaceBacklog(
          state,
          collectUnsupersededBacklog(
            state.backlog,
            sessionID,
            event['seq'],
            state.sendingReplays.has(sessionID),
          ),
        );
      }

      scheduleEvent(state, event, 0);

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

// The chunks of one replay enter in one synchronous burst, so a replay of the session whose last
// queued chunk is not its last is the one still entering.
function isReplayOpen(backlog: readonly QueuedEvent[], sessionID: SessionID): boolean {
  const last = backlog.findLast(
    (queued) => queued.event.ev === 'SessionReplay' && findEventSession(queued.event) === sessionID,
  );

  return last !== undefined && last.event['done'] !== true;
}

function replaceBacklog(state: FeedState, kept: readonly QueuedEvent[]): void {
  state.backlog.length = 0;

  state.backlog.push(...kept);

  state.queuedBytes = kept.reduce((total, queued) => total + queued.bytes, 0);
}

// A client joins the chunks of a replay until its last one, so a replay it has started reading
// stays whole; output at or below the newer replay's seq is already in that replay.
function collectUnsupersededBacklog(
  backlog: readonly QueuedEvent[],
  sessionID: SessionID,
  replaySeq: unknown,
  isSendingReplay: boolean,
): QueuedEvent[] {
  let isKeepingReplay = isSendingReplay;

  return backlog.filter((queued) => {
    const event = queued.event;

    if (findEventSession(event) !== sessionID) {
      return true;
    }

    if (event.ev === 'SessionReplay') {
      const isKept = isKeepingReplay;

      isKeepingReplay &&= event['done'] !== true;

      return isKept;
    }

    return !(
      event.ev === 'SessionOutput' &&
      typeof event['seq'] === 'number' &&
      typeof replaySeq === 'number' &&
      event['seq'] <= replaySeq
    );
  });
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

        recordReplaySent(state, next.event);
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

function recordReplaySent(state: FeedState, event: EventMsg): void {
  const sessionID = findEventSession(event);

  if (event.ev !== 'SessionReplay' || sessionID === null) {
    return;
  }

  if (event['done'] === true) {
    state.sendingReplays.delete(sessionID);
  } else {
    state.sendingReplays.add(sessionID);
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
  state.sendingReplays.delete(sessionID);

  replaceBacklog(
    state,
    state.backlog.filter((queued) => findEventSession(queued.event) !== sessionID),
  );
}
