import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { createActor } from 'xstate';
import { DaemonError } from '../daemon-error';
import { TRANSPORT_MACHINE } from './transport-machine';
import type { TransportReconnect } from './transport-machine';

export interface TransportChannel {
  onClose: () => void;
  readonly stop: () => void;

  // Whether the connection already ended, for a channel that can tell; one
  // that ends before the transport follows it counts as lost at once.
  readonly isClosed?: () => boolean;
}

export type TransportState = 'idle' | 'connecting' | 'ready' | 'backoff' | 'closed';

interface DaemonTransportOptions<C> {
  // Opens and handshakes one connection. It gets how many connections the
  // transport opened before this one, so a first open can differ from a
  // reconnect.
  readonly open: (opened: number) => Promise<C>;
  readonly getChannel: (connection: C) => TransportChannel;
  readonly reconnect: TransportReconnect;

  // The waits before an `always` transport opens again: the first follows
  // a lost connection, each failed open in a row takes the next, and the
  // last one repeats. Zero when unset.
  readonly backoffMs?: readonly number[];

  // Whether an open's failure ends the transport for good instead of
  // waiting for the next open; none is fatal when unset.
  readonly isFatal?: (error: unknown) => boolean;

  // Runs once a connection is ready, before any request that waited on it
  // gets it.
  readonly onReady?: (connection: C) => void;

  // Runs once the ready connection ends, or a caller drops it.
  readonly onLost?: (connection: C) => void;

  // Runs when an open fails, with whether the failure ended the transport.
  readonly onOpenFailed?: (error: unknown, fatal: boolean) => void;

  // Runs the backoff timers; the system clock when unset.
  readonly clock?: Clock;
}

export interface DaemonTransport<C> {
  readonly waitForConnection: () => Promise<C>;
  readonly readState: () => TransportState;
  readonly findLatest: () => C | null;

  // Whether the connection ended or was dropped, so a send that failed on it
  // got no answer.
  readonly isLost: (connection: C) => boolean;
  readonly stopConnection: (connection: C) => void;
  readonly stop: () => void;
}

export function createDaemonTransport<C>(opts: DaemonTransportOptions<C>): DaemonTransport<C> {
  const actor = createActor(TRANSPORT_MACHINE, { input: { reconnect: opts.reconnect } }).start();

  const lost = new WeakSet<TransportChannel>();

  let current: C | null = null;
  let latest: C | null = null;
  let opened = 0;
  let waiters: PromiseWithResolvers<C>[] = [];
  let cancelBackoff: (() => void) | null = null;
  const readState = (): TransportState => actor.getSnapshot().value;

  const drainWaiters = (error: unknown) => {
    const drained = waiters;

    waiters = [];

    for (const waiter of drained) {
      waiter.reject(error);
    }
  };

  const scheduleRetry = () => {
    const delays = opts.backoffMs ?? [0];
    const failures = actor.getSnapshot().context.failures;
    const delayMs = delays[Math.min(failures, delays.length - 1)] ?? 0;

    cancelBackoff = (opts.clock ?? systemClock).schedule(() => {
      cancelBackoff = null;

      if (readState() !== 'backoff') {
        return;
      }

      actor.send({ type: 'RETRY' });
      void openConnection();
    }, delayMs);
  };

  // Marks a connection lost; when it is the ready one, the transport goes
  // back to idle or into a backoff.
  const recordLoss = (connection: C) => {
    lost.add(opts.getChannel(connection));

    if (current !== connection) {
      return;
    }

    current = null;

    actor.send({ type: 'LOST' });
    opts.onLost?.(connection);

    if (readState() === 'backoff') {
      scheduleRetry();
    }
  };

  const recordOpenFailure = (error: unknown) => {
    if (readState() !== 'connecting') {
      return;
    }

    const fatal = opts.isFatal?.(error) ?? false;

    actor.send({ type: 'OPEN_FAILED', fatal });
    opts.onOpenFailed?.(error, fatal);

    if (readState() === 'backoff') {
      scheduleRetry();

      return;
    }

    drainWaiters(error);
  };

  const openConnection = async () => {
    let connection: C;

    try {
      connection = await opts.open(opened);
    } catch (error) {
      recordOpenFailure(error);

      return;
    }

    // A transport stopped while the connection opened closes it at once,
    // so a late open never leaks.
    if (readState() !== 'connecting') {
      opts.getChannel(connection).stop();

      return;
    }

    opened += 1;
    current = connection;
    latest = connection;

    opts.getChannel(connection).onClose = () => {
      recordLoss(connection);
    };

    actor.send({ type: 'OPENED' });
    opts.onReady?.(connection);
    const resolved = waiters;

    waiters = [];

    for (const waiter of resolved) {
      waiter.resolve(connection);
    }

    if (opts.getChannel(connection).isClosed?.() === true) {
      recordLoss(connection);
    }
  };

  const startOpen = () => {
    actor.send({ type: 'CONNECT' });
    void openConnection();
  };

  return {
    waitForConnection: () => {
      const state = readState();

      if (state === 'ready' && current !== null) {
        return Promise.resolve(current);
      }

      if (state === 'closed') {
        return Promise.reject(new DaemonError('internal', 'the daemon transport is stopped'));
      }

      const waiter = Promise.withResolvers<C>();

      waiters.push(waiter);

      if (state === 'idle') {
        startOpen();
      }

      return waiter.promise;
    },

    readState,
    findLatest: () => latest,
    isLost: (connection) => lost.has(opts.getChannel(connection)),

    stopConnection: (connection) => {
      recordLoss(connection);

      opts.getChannel(connection).stop();
    },

    stop: () => {
      const stopped = current;

      cancelBackoff?.();
      cancelBackoff = null;
      current = null;

      actor.send({ type: 'STOP' });

      if (stopped !== null) {
        lost.add(opts.getChannel(stopped));
        opts.getChannel(stopped).stop();
      }

      drainWaiters(new DaemonError('internal', 'the daemon transport is stopped'));
    },
  };
}
