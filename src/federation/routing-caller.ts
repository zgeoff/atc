import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { buildGatewayError } from './build-gateway-error';
import { buildGatewayResult } from './build-gateway-result';
import type { DaemonCaller } from './daemon-caller';
import type { DaemonPool } from './daemon-pool';
import { GatewayError } from './gateway-error';
import type { GatewayStore } from './gateway-store';
import { pickDaemonState } from './pick-daemon-state';
import { readFleetEvents } from './read-fleet-events';
import { requireServingDaemon } from './require-serving-daemon';
import { resolveDaemonRequest } from './resolve-daemon-request';
import type { GatewayFeature, GatewayRegistry, RegistryDaemon } from './types';
import { waitForOutcome } from './wait-for-outcome';
import type { CallOutcome } from './wait-for-outcome';

interface RoutingCallerOptions {
  readonly registry: GatewayRegistry;
  readonly pool: DaemonPool;
  readonly store: GatewayStore;

  // How long each daemon may take to answer a call the gateway asks every
  // daemon; 5 s when unset.
  readonly fanOutTimeoutMs?: number;
  readonly now?: () => number;
}

const FAN_OUT_TIMEOUT_MS = 5000;

// The requests a daemon runs at most once under an idempotency key.
const KEYED_METHODS: ReadonlySet<string> = new Set(['session.spawn', 'session.message']);

// A keyed request on its way to a daemon: the daemon its ids or the
// default picked, and the one its `daemon` param named, if any.
interface KeyedRoute {
  readonly m: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly picked: RegistryDaemon;
  readonly named: RegistryDaemon | null;
  readonly required: readonly DaemonFeature[];
  readonly principal: string;
}

/**
 * The gateway's caller for the MCP tools, the same shape as the caller the
 * tool handlers take: each request goes to the one
 * daemon its ids, its `daemon` param, or the registry's default daemon
 * picks, in that order, and never to another daemon when that one fails.
 * A request always acts as the principal it is given, which the HTTP layer
 * takes from the verified OAuth client id, and a request without one never
 * leaves. A keyed spawn or message is bound to its daemon before it is
 * sent, so a retry reaches the same daemon whatever the default is by
 * then. `session.list`, `agents.list`, and `events.read` ask every daemon
 * in parallel and report the daemons that did not answer; `daemons.list`
 * answers from the gateway itself. Every id in an answer or a daemon's
 * error comes back as a gateway id.
 */
export class RoutingCaller {
  private readonly opts: RoutingCallerOptions;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the options hold the live daemon pool and binding store
  constructor(opts: RoutingCallerOptions) {
    this.opts = opts;
  }

  sendRequest(
    m: string,
    p: Readonly<Record<string, unknown>> = {},
    required: readonly DaemonFeature[] = [],
    principal?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (principal === undefined) {
      return Promise.reject(
        new Error('the gateway sends a request only as the verified client of the call'),
      );
    }

    const { daemon: named, ...params } = p;

    return match(m)
      .with('daemons.list', () => this.readDaemonStates())
      .with('session.list', 'agents.list', (fanned) => this.sendFanOut(fanned, required, principal))
      .with('events.read', () =>
        readFleetEvents(
          { registry: this.opts.registry, getCaller: this.getCaller, timeoutMs: this.getTimeout() },
          params,
          required,
          principal,
        ),
      )
      .otherwise(() => this.sendRouted(m, params, named, required, principal));
  }

  /**
   * The features any daemon that is up announces, plus `fleet.daemons`, so
   * the tool list offers an option when at least one daemon serves it and
   * the inputs that pick a daemon always.
   */
  async readFeatures(): Promise<ReadonlySet<GatewayFeature>> {
    const outcomes = await Promise.all(
      [...this.opts.registry.daemons.values()].map((daemon) =>
        waitForOutcome(this.opts.pool.getCaller(daemon.name).readHello(), this.getTimeout()),
      ),
    );

    const features = new Set<GatewayFeature>(['fleet.daemons']);

    for (const outcome of outcomes) {
      if (outcome.kind === 'answered') {
        for (const feature of outcome.value.features) {
          features.add(feature);
        }
      }
    }

    return features;
  }

  private readonly getCaller = (name: string): DaemonCaller => this.opts.pool.getCaller(name);

  private getTimeout(): number {
    return this.opts.fanOutTimeoutMs ?? FAN_OUT_TIMEOUT_MS;
  }

  private getNow(): number {
    return this.opts.now === undefined ? Date.now() : this.opts.now();
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

  private async sendRouted(
    m: string,
    params: Readonly<Record<string, unknown>>,
    rawNamed: unknown,
    required: readonly DaemonFeature[],
    principal: string,
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
    const key = typeof rawKey === 'string' && KEYED_METHODS.has(m) ? rawKey : null;

    const daemon =
      key === null
        ? picked
        : await this.claimRoute({
            m,
            params: route.params,
            key,
            picked,
            named,
            required,
            principal,
          });

    if (key === null) {
      await requireServingDaemon(this.getCaller, daemon, required);
    }

    try {
      const ok = await this.opts.pool
        .getCaller(daemon.name)
        .sendRequest(m, route.params, principal);

      if (key !== null) {
        this.opts.store.updateOutcome(principal, m, key, 'completed', this.getNow());
      }

      return buildGatewayResult(m, ok, daemon);
    } catch (error) {
      if (key !== null && error instanceof DaemonError) {
        const outcome = error.code === 'outcome_unknown' ? 'uncertain' : 'completed';

        this.opts.store.updateOutcome(principal, m, key, outcome, this.getNow());
      }

      if (error instanceof DaemonError) {
        throw buildGatewayError(error, daemon, route.requestIDs);
      }

      throw error;
    }
  }

  // The daemon a keyed request goes to: the one an earlier call with the
  // same principal, operation, and key was bound to, or else the one the
  // call picked, bound now, before anything is sent. A bound daemon whose
  // state identity changed, or that left the registry, is unavailable; the
  // key never goes to another daemon. Completed bindings past their
  // retention go first.
  private async claimRoute(route: KeyedRoute): Promise<RegistryDaemon> {
    const store = this.opts.store;

    store.removeExpiredBindings(this.getNow());

    const held = store.findBinding(route.principal, route.m, route.key);
    const bound = held === null ? null : this.opts.registry.daemons.get(held.daemon);

    if (held !== null && (bound === undefined || bound?.daemonID !== held.daemonID)) {
      throw new GatewayError(
        'daemon_unavailable',
        `daemon '${held.daemon}', which idempotency key '${route.key}' went to, now has another state identity`,
        { daemon: held.daemon, reason: 'daemon_changed' },
      );
    }

    if (held !== null && route.named !== null && route.named.name !== held.daemon) {
      throw new DaemonError(
        'idempotency_conflict',
        `idempotency key '${route.key}' was first used on daemon '${held.daemon}'`,
      );
    }

    const daemon = bound ?? route.picked;

    const hello = await requireServingDaemon(this.getCaller, daemon, route.required);

    store.claimBinding(
      {
        principal: route.principal,
        operation: route.m,
        key: route.key,
        daemon: daemon.name,
        daemonID: daemon.daemonID,
        retentionMs: hello.retentionMs,
        payloadHash: buildBindingPayloadHash(route.params),
      },
      this.getNow(),
    );

    return daemon;
  }

  // Asks every daemon at once. `session.list` merges the sessions and adds
  // each daemon's state, so a daemon that did not answer reads as down,
  // never as one with no sessions; `agents.list` returns each daemon's
  // answer, or its state alone, under its name.
  private async sendFanOut(
    m: 'session.list' | 'agents.list',
    required: readonly DaemonFeature[],
    principal: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const daemons = [...this.opts.registry.daemons.values()];

    const outcomes = await Promise.all(
      daemons.map((daemon) =>
        waitForOutcome(this.sendToDaemon(m, daemon, required, principal), this.getTimeout()),
      ),
    );

    const answered = daemons.map((daemon, index) => ({
      daemon,
      outcome: outcomes[index] ?? ({ kind: 'timeout' } as const),
    }));

    if (m === 'agents.list') {
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

    return {
      sessions: answered.flatMap((entry) => collectSessions(entry.outcome)),
      daemons: answered.map((entry) => ({
        name: entry.daemon.name,
        state: pickDaemonState(entry.outcome),
      })),
    };
  }

  private async sendToDaemon(
    m: string,
    daemon: RegistryDaemon,
    required: readonly DaemonFeature[],
    principal: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    await requireServingDaemon(this.getCaller, daemon, required);

    const ok = await this.opts.pool.getCaller(daemon.name).sendRequest(m, {}, principal);

    return buildGatewayResult(m, ok, daemon);
  }

  // Each daemon's name, state, build, pinned state identity, and features,
  // read from its handshake, and the default daemon. Never an address or a
  // token.
  private async readDaemonStates(): Promise<Readonly<Record<string, unknown>>> {
    const daemons = [...this.opts.registry.daemons.values()];

    const outcomes = await Promise.all(
      daemons.map((daemon) =>
        waitForOutcome(this.opts.pool.getCaller(daemon.name).readHello(), this.getTimeout()),
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
          features: hello === null ? [] : [...hello.features].toSorted(),
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
