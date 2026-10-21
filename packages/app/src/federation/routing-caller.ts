import { randomUUID } from 'node:crypto';
import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { Principal } from '@atc/protocol';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { buildGatewayError } from './build-gateway-error';
import { buildGatewayResult } from './build-gateway-result';
import type { DaemonPool } from './daemon-pool';
import type { GatewayDaemonCaller } from './gateway-daemon-caller';
import { GatewayError } from './gateway-error';
import type { GatewayStore } from './gateway-store';
import { pickDaemonState } from './pick-daemon-state';
import { readFleetEvents } from './read-fleet-events';
import { resolveDaemonRequest } from './resolve-daemon-request';
import type { GatewayFeature, GatewayRegistry, ParamsPreparer, RegistryDaemon } from './types';
import { waitForOutcome } from './wait-for-outcome';
import type { CallOutcome } from './wait-for-outcome';

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

// One routed request as it leaves for its daemon; `key` is null for an
// unkeyed request.
interface RoutedSend {
  readonly method: string;
  readonly route: ReturnType<typeof resolveDaemonRequest>;
  readonly daemon: RegistryDaemon;
  readonly principal: Principal;
  readonly key: string | null;

  // Picks the params of each write of the request, right before it.
  readonly prepareParams?: ParamsPreparer;
}

// A keyed request on its way to a daemon: the daemon its ids or the
// default picked, and the one its `daemon` param named, if any.
interface KeyedRoute {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly picked: RegistryDaemon;
  readonly named: RegistryDaemon | null;
  readonly principal: Principal;
}

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

  private getDefaultDaemon(): RegistryDaemon {
    const daemon = this.opts.registry.daemons.get(this.opts.registry.defaultDaemon);

    if (daemon === undefined) {
      throw new Error('the registry default daemon is missing from the registry');
    }

    return daemon;
  }

  private sendRouted(
    method: string,
    params: Readonly<Record<string, unknown>>,
    rawNamed: unknown,
    principal: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const named = this.findNamedDaemon(rawNamed);
    const route = resolveDaemonRequest(params, this.opts.registry);

    if (route.daemon !== null && named !== null && route.daemon !== named) {
      throw new DaemonError(
        'bad_args',
        `the call's ids belong to daemon '${route.daemon.name}', not '${named.name}'`,
      );
    }

    const picked = route.daemon ?? named ?? this.getDefaultDaemon();
    const rawKey = route.params['idempotencyKey'];

    const key =
      typeof rawKey === 'string' && PROCEDURE_TRAITS.get(method)?.keyed === true ? rawKey : null;

    if (key === null) {
      return this.sendToRoute({ method, route, daemon: picked, principal, key: null });
    }

    const keyed: KeyedRoute = { method, params: route.params, key, picked, named, principal };

    return this.sendKeyed(keyed, route);
  }

  private async sendKeyed(
    keyed: KeyedRoute,
    route: RoutedSend['route'],
  ): Promise<Readonly<Record<string, unknown>>> {
    const claimed = await this.claimRoute(keyed);

    try {
      return await this.sendToRoute({
        method: keyed.method,
        route,
        daemon: claimed.daemon,
        principal: keyed.principal,
        key: keyed.key,

        // marks the key sent right before each write, so only the first write under it, across
        // calls and gateway processes, runs; a later one goes out replay-only
        prepareParams: (params) =>
          this.opts.store.claimFirstSend(
            keyed.principal.id,
            keyed.method,
            keyed.key,
            this.getClock().now(),
          )
            ? params
            : { ...params, replayOnly: true },
      });
    } catch (error) {
      // a refusal before anything was sent leaves no trace of the key
      if (error instanceof GatewayError) {
        this.opts.store.removeBinding(keyed.principal.id, keyed.method, keyed.key, claimed.claimID);
      }

      throw error;
    }
  }

  // Sends one routed request to its daemon, and records a keyed request's
  // outcome on its binding.
  private async sendToRoute(send: RoutedSend): Promise<Readonly<Record<string, unknown>>> {
    const store = this.opts.store;

    try {
      const ok = await this.opts.pool
        .getCaller(send.daemon.name)
        .sendRequest(send.method, send.route.params, send.principal, send.prepareParams);

      if (send.key !== null) {
        store.updateOutcome(
          send.principal.id,
          send.method,
          send.key,
          'completed',
          this.getClock().now(),
        );
      }

      return buildGatewayResult(send.method, ok, send.daemon);
    } catch (error) {
      if (send.key !== null && error instanceof DaemonError) {
        const outcome = error.code === 'outcome_unknown' ? 'uncertain' : 'completed';
        const rawRef = error.data?.['effectRef'];
        const effectRef = typeof rawRef === 'string' ? rawRef : null;

        store.updateOutcome(
          send.principal.id,
          send.method,
          send.key,
          outcome,
          this.getClock().now(),
          effectRef,
        );

        const held = store.findBinding(send.principal.id, send.method, send.key);

        // An unknown outcome carries the daemon's id of the effect when any
        // answer under the key returned one.
        if (
          outcome === 'uncertain' &&
          effectRef === null &&
          held !== null &&
          held.effectRef !== null
        ) {
          const known = new DaemonError(error.code, error.message, {
            ...error.data,
            effectRef: held.effectRef,
          });

          throw buildGatewayError(known, send.daemon, send.route.requestIDs);
        }
      }

      if (error instanceof DaemonError) {
        throw buildGatewayError(error, send.daemon, send.route.requestIDs);
      }

      throw error;
    }
  }

  private async claimRoute(
    route: KeyedRoute,
  ): Promise<{ readonly daemon: RegistryDaemon; readonly claimID: string }> {
    const store = this.opts.store;
    const now = this.getClock().now();

    // expired bindings go first, so a key past its retention binds afresh
    store.removeExpiredBindings(now);

    const held = store.findBinding(route.principal.id, route.method, route.key);
    const bound = held === null ? null : this.opts.registry.daemons.get(held.daemon);

    // a key never moves to another daemon, even when its bound daemon changed or left
    if (held !== null && (bound === undefined || bound?.daemonID !== held.daemonID)) {
      throw new GatewayError(
        'daemon_unavailable',
        `daemon '${held.daemon}', which idempotency key '${route.key}' went to, now has another state identity`,
        { daemon: held.daemon, reason: 'daemon_changed' },
      );
    }

    if (held !== null && route.named !== null && route.named.name !== held.daemon) {
      throw buildConflict(route.key, held.daemon);
    }

    const daemon = bound ?? route.picked;

    const hello = await this.getCaller(daemon.name).readHello();

    const claimID = randomUUID();

    const binding = store.claimBinding(
      {
        principal: route.principal.id,
        operation: route.method,
        key: route.key,
        daemon: daemon.name,
        daemonID: daemon.daemonID,
        retentionMs: hello.retentionMs,
        payloadHash: buildBindingPayloadHash(route.params),
        claimID,
      },
      this.getClock().now(),
    );

    // Another gateway call may have bound the key since it was read; the
    // request goes only where the stored binding points.
    if (binding.daemon !== daemon.name) {
      throw buildConflict(route.key, binding.daemon);
    }

    return { daemon, claimID };
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

function buildConflict(key: string, daemon: string): DaemonError {
  return new DaemonError(
    'idempotency_conflict',
    `idempotency key '${key}' was first used on daemon '${daemon}'`,
  );
}
