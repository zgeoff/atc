import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { Principal } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { buildGatewayResult } from './build-gateway-result';
import type { DaemonPool } from './daemon-pool';
import type { GatewayDaemonCaller } from './gateway-daemon-caller';
import type { GatewayStore } from './gateway-store';
import { pickDaemonState } from './pick-daemon-state';
import { readFleetEvents } from './read-fleet-events';
import { sendRoutedCall } from './send-routed-call';
import type { GatewayFeature, GatewayRegistry, RegistryDaemon, RoutedCall } from './types';
import { waitForOutcome } from './wait-for-outcome';
import type { CallOutcome } from './wait-for-outcome';
import { withDaemonPick } from './with-daemon-pick';
import { withGatewayIDs } from './with-gateway-ids';
import { withKeyBinding } from './with-key-binding';

interface RoutingCallerOptions {
  readonly registry: GatewayRegistry;
  readonly pool: DaemonPool;
  readonly store: GatewayStore;

  // How long each daemon may take to answer a call the gateway asks every
  // daemon; 5 s when unset.
  readonly fanOutTimeoutMs?: number;

  // Runs the fan-out waits and reads the time for the binding store; the
  // system clock when unset.
  readonly clock?: Clock;
}

const FAN_OUT_TIMEOUT_MS = 5000;

export class RoutingCaller {
  private readonly opts: RoutingCallerOptions;

  constructor(opts: RoutingCallerOptions) {
    this.opts = opts;
  }

  sendRequest(
    method: string,
    requestParams: Readonly<Record<string, unknown>> = {},
    principal?: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (principal === undefined) {
      return Promise.reject(
        new Error('the gateway sends a request only as the verified client of the call'),
      );
    }

    const { daemon: named, ...params } = requestParams;

    return match(method)
      .with('daemons.list', () => this.readDaemonStates())
      .with('session.list', 'agents.list', (fanned) => this.sendFanOut(fanned, principal))
      .with('events.read', () =>
        readFleetEvents(
          {
            registry: this.opts.registry,
            getCaller: this.getCaller,
            timeoutMs: this.getTimeout(),
            clock: this.getClock(),
          },
          params,
          principal,
        ),
      )
      .otherwise(() => this.sendRouted(method, params, named, principal));
  }

  readonly features: ReadonlySet<GatewayFeature> = new Set<GatewayFeature>(['fleet.daemons']);

  // The gateway dials each daemon only when a call needs it, and a listing
  // reports a daemon it cannot reach as down, so no single daemon gates it.
  waitForDaemon(): Promise<void> {
    return Promise.resolve();
  }

  private readonly getCaller = (name: string): GatewayDaemonCaller =>
    this.opts.pool.getCaller(name);

  private getTimeout(): number {
    return this.opts.fanOutTimeoutMs ?? FAN_OUT_TIMEOUT_MS;
  }

  private getClock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  // The daemon a `daemon` param picks, or null when the call gives none.
  private findNamedDaemon(named: unknown): RegistryDaemon | null {
    if (named === undefined) {
      return null;
    }

    const daemon = typeof named === 'string' ? this.opts.registry.daemons.get(named) : undefined;

    if (daemon === undefined) {
      const shown = typeof named === 'string' ? named : JSON.stringify(named);

      throw new DaemonError('bad_args', `no daemon '${shown}' in this gateway`);
    }

    return daemon;
  }

  // The steps of a routed call, outermost first: the id rules, the daemon
  // pick, the key binding, then the pass-through to the daemon.
  private async sendRouted(
    method: string,
    params: Readonly<Record<string, unknown>>,
    rawNamed: unknown,
    principal: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const registry = this.opts.registry;
    const pool = this.opts.pool;
    const binding = { registry, pool, store: this.opts.store, clock: this.getClock() };

    const call: RoutedCall = {
      method,
      params,
      principal,
      named: this.findNamedDaemon(rawNamed),
      owner: null,
      daemon: null,
    };

    const outcome = await withGatewayIDs(registry, call, (resolved) =>
      withDaemonPick(registry, resolved, (picked) =>
        withKeyBinding(binding, picked, (bound) => sendRoutedCall(pool, bound)),
      ),
    );

    return match(outcome)
      .with({ kind: 'answered' }, (answered) => answered.value)
      .with({ kind: 'refused' }, (refused) => {
        throw refused.error;
      })
      .exhaustive();
  }

  private async sendFanOut(
    method: 'session.list' | 'agents.list',
    principal: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const daemons = [...this.opts.registry.daemons.values()];

    const outcomes = await Promise.all(
      daemons.map((daemon) =>
        waitForOutcome(
          this.sendToDaemon(method, daemon, principal),
          this.getTimeout(),
          this.getClock(),
        ),
      ),
    );

    const answered = daemons.map((daemon, index) => ({
      daemon,
      outcome: outcomes[index] ?? ({ kind: 'timeout' } as const),
    }));

    if (method === 'agents.list') {
      return {
        daemons: Object.fromEntries(
          answered.map((entry) => [
            entry.daemon.name,
            entry.outcome.kind === 'answered'
              ? { state: 'up', ...entry.outcome.value }
              : { state: pickDaemonState(entry.outcome) },
          ]),
        ),
      };
    }

    // each daemon's state sits beside the merged sessions, so one that did not answer reads
    // as down, never as one with no sessions
    return {
      sessions: answered.flatMap((entry) => collectSessions(entry.outcome)),
      daemons: answered.map((entry) => ({
        name: entry.daemon.name,
        state: pickDaemonState(entry.outcome),
      })),
    };
  }

  private async sendToDaemon(
    method: string,
    daemon: RegistryDaemon,
    principal: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const ok = await this.opts.pool.getCaller(daemon.name).sendRequest(method, {}, principal);

    return buildGatewayResult(method, ok, daemon);
  }

  // Each daemon's name, state, build, and pinned state identity, read from
  // its handshake, and the default daemon. Never an address or a token.
  private async readDaemonStates(): Promise<Readonly<Record<string, unknown>>> {
    const daemons = [...this.opts.registry.daemons.values()];

    const outcomes = await Promise.all(
      daemons.map((daemon) =>
        waitForOutcome(
          this.opts.pool.getCaller(daemon.name).readHello(),
          this.getTimeout(),
          this.getClock(),
        ),
      ),
    );

    return {
      daemons: daemons.map((daemon, index) => {
        const outcome = outcomes[index] ?? ({ kind: 'timeout' } as const);
        const hello = outcome.kind === 'answered' ? outcome.value : null;

        return {
          name: daemon.name,
          state: pickDaemonState(outcome),
          build: hello?.build ?? null,
          daemonID: daemon.daemonID,
        };
      }),
      defaultDaemon: this.opts.registry.defaultDaemon,
    };
  }
}

function collectSessions(outcome: CallOutcome<Readonly<Record<string, unknown>>>): unknown[] {
  if (outcome.kind !== 'answered') {
    return [];
  }

  const sessions: unknown = outcome.value['sessions'];

  return Array.isArray(sessions) ? sessions : [];
}
