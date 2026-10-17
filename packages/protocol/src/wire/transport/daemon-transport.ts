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

export class DaemonTransport<C> {
  private readonly opts: DaemonTransportOptions<C>;

  private readonly actor;

  private current: C | null = null;

  private latest: C | null = null;

  private opened = 0;

  private readonly lost = new WeakSet<TransportChannel>();

  private waiters: PromiseWithResolvers<C>[] = [];

  private cancelBackoff: (() => void) | null = null;

  constructor(opts: DaemonTransportOptions<C>) {
    this.opts = opts;
    this.actor = createActor(TRANSPORT_MACHINE, { input: { reconnect: opts.reconnect } }).start();
  }

  waitForConnection(): Promise<C> {
    const state = this.readState();

    if (state === 'ready' && this.current !== null) {
      return Promise.resolve(this.current);
    }

    if (state === 'closed') {
      return Promise.reject(new DaemonError('internal', 'the daemon transport is stopped'));
    }

    const waiter = Promise.withResolvers<C>();

    this.waiters.push(waiter);

    if (state === 'idle') {
      this.startOpen();
    }

    return waiter.promise;
  }

  readState(): TransportState {
    return this.actor.getSnapshot().value;
  }

  findLatest(): C | null {
    return this.latest;
  }

  // Whether the connection ended or was dropped, so a send that failed on it
  // got no answer.
  isLost(connection: C): boolean {
    return this.lost.has(this.opts.getChannel(connection));
  }

  stopConnection(connection: C): void {
    this.recordLoss(connection);
    this.opts.getChannel(connection).stop();
  }

  stop(): void {
    const current = this.current;

    this.cancelBackoff?.();
    this.cancelBackoff = null;
    this.current = null;

    this.actor.send({ type: 'STOP' });

    if (current !== null) {
      this.lost.add(this.opts.getChannel(current));
      this.opts.getChannel(current).stop();
    }

    this.drainWaiters(new DaemonError('internal', 'the daemon transport is stopped'));
  }

  private startOpen(): void {
    this.actor.send({ type: 'CONNECT' });
    void this.openConnection();
  }

  private async openConnection(): Promise<void> {
    let connection: C;

    try {
      connection = await this.opts.open(this.opened);
    } catch (error) {
      this.recordOpenFailure(error);

      return;
    }

    // A transport stopped while the connection opened closes it at once,
    // so a late open never leaks.
    if (this.readState() !== 'connecting') {
      this.opts.getChannel(connection).stop();

      return;
    }

    this.opened += 1;
    this.current = connection;
    this.latest = connection;

    this.opts.getChannel(connection).onClose = () => {
      this.recordLoss(connection);
    };

    this.actor.send({ type: 'OPENED' });
    this.opts.onReady?.(connection);
    const waiters = this.waiters;

    this.waiters = [];

    for (const waiter of waiters) {
      waiter.resolve(connection);
    }

    if (this.opts.getChannel(connection).isClosed?.() === true) {
      this.recordLoss(connection);
    }
  }

  private recordOpenFailure(error: unknown): void {
    if (this.readState() !== 'connecting') {
      return;
    }

    const fatal = this.opts.isFatal?.(error) ?? false;

    this.actor.send({ type: 'OPEN_FAILED', fatal });
    this.opts.onOpenFailed?.(error, fatal);

    if (this.readState() === 'backoff') {
      this.scheduleRetry();

      return;
    }

    this.drainWaiters(error);
  }

  // Marks a connection lost; when it is the ready one, the transport goes
  // back to idle or into a backoff.
  private recordLoss(connection: C): void {
    this.lost.add(this.opts.getChannel(connection));

    if (this.current !== connection) {
      return;
    }

    this.current = null;

    this.actor.send({ type: 'LOST' });
    this.opts.onLost?.(connection);

    if (this.readState() === 'backoff') {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    const delays = this.opts.backoffMs ?? [0];
    const failures = this.actor.getSnapshot().context.failures;
    const delayMs = delays[Math.min(failures, delays.length - 1)] ?? 0;

    this.cancelBackoff = (this.opts.clock ?? systemClock).schedule(() => {
      this.cancelBackoff = null;

      if (this.readState() !== 'backoff') {
        return;
      }

      this.actor.send({ type: 'RETRY' });
      void this.openConnection();
    }, delayMs);
  }

  private drainWaiters(error: unknown): void {
    const waiters = this.waiters;

    this.waiters = [];

    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}
