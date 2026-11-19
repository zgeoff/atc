import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { createActor } from 'xstate';
import { DaemonError } from '../daemon-error';
import { TRANSPORT_MACHINE } from './transport-machine';
import type { TransportReconnect } from './transport-machine';

export interface TransportChannel {
  onClose: () => void;
  readonly stop: () => void;

  readonly isClosed?: () => boolean;
}

export type TransportState = 'idle' | 'connecting' | 'ready' | 'backoff' | 'closed';

interface DaemonTransportOptions<C> {
  readonly open: (opened: number) => Promise<C>;
  readonly getChannel: (connection: C) => TransportChannel;
  readonly reconnect: TransportReconnect;

  readonly backoffMs?: readonly number[];

  readonly isFatal?: (error: unknown) => boolean;

  readonly onReady?: (connection: C) => void;

  readonly onLost?: (connection: C) => void;

  readonly onOpenFailed?: (error: unknown, fatal: boolean) => void;

  readonly clock?: Clock;
}

export interface DaemonTransport<C> {
  readonly waitForConnection: () => Promise<C>;
  readonly readState: () => TransportState;
  readonly findLatest: () => C | null;

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
