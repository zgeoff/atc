import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { buildGatewayError } from './build-gateway-error';
import { buildGatewayResult } from './build-gateway-result';
import type { DaemonCaller } from './daemon-caller';
import type { DaemonPool } from './daemon-pool';
import { GatewayError } from './gateway-error';
import type { GatewayStore, KeyBinding } from './gateway-store';
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

// One routed request as it leaves for its daemon; `key` is null for an
// unkeyed request.
interface RoutedSend {
  readonly m: string;
  readonly route: ReturnType<typeof resolveDaemonRequest>;
  readonly daemon: RegistryDaemon;
  readonly required: readonly DaemonFeature[];
  readonly principal: string;
  readonly key: string | null;
}

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

  // The last keyed call holding each key's lock.
  private readonly keyLocks = new Map<string, Promise<void>>();

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

  private sendRouted(
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

    if (key === null) {
      return this.sendToRoute({ m, route, daemon: picked, required, principal, key: null });
    }

    const keyed: KeyedRoute = { m, params: route.params, key, picked, named, required, principal };

    // Keyed requests with one key run one at a time, so a second waits for
    // the first's binding and outcome instead of racing it to a daemon.
    return this.withKeyLock(JSON.stringify([principal, m, key]), async () => {
      const claimed = await this.claimRoute(keyed);

      try {
        return await this.sendToRoute({
          m,
          route,
          daemon: claimed.daemon,
          required,
          principal,
          key,
        });
      } catch (error) {
        // A refusal about the daemon comes before anything is sent, so a
        // binding this call made leaves no trace of the key.
        if (claimed.created && error instanceof GatewayError) {
          this.opts.store.removeBinding(principal, m, key);
        }

        throw error;
      }
    });
  }

  // Sends one routed request to its daemon on a connection whose handshake
  // announces every feature the request relies on, and records a keyed
  // request's outcome on its binding.
  private async sendToRoute(send: RoutedSend): Promise<Readonly<Record<string, unknown>>> {
    const store = this.opts.store;

    try {
      const ok = await this.opts.pool
        .getCaller(send.daemon.name)
        .sendRequest(send.m, send.route.params, send.principal, send.required);

      if (send.key !== null) {
        store.updateOutcome(send.principal, send.m, send.key, 'completed', this.getNow());
      }

      return buildGatewayResult(send.m, ok, send.daemon);
    } catch (error) {
      if (send.key !== null && error instanceof DaemonError) {
        const outcome = error.code === 'outcome_unknown' ? 'uncertain' : 'completed';
        const rawRef = error.data?.['effectRef'];
        const effectRef = typeof rawRef === 'string' ? rawRef : null;

        store.updateOutcome(send.principal, send.m, send.key, outcome, this.getNow(), effectRef);
      }

      if (error instanceof DaemonError) {
        throw buildGatewayError(error, send.daemon, send.route.requestIDs);
      }

      throw error;
    }
  }

  // Runs `run` once every earlier call holding the same lock has settled.
  private async withKeyLock<T>(lock: string, run: () => Promise<T>): Promise<T> {
    const before = this.keyLocks.get(lock);
    const turn = Promise.withResolvers<void>();

    this.keyLocks.set(lock, turn.promise);

    if (before !== undefined) {
      await before;
    }

    try {
      return await run();
    } finally {
      turn.resolve();

      if (this.keyLocks.get(lock) === turn.promise) {
        this.keyLocks.delete(lock);
      }
    }
  }

  // The daemon a keyed request goes to: the one an earlier call with the
  // same principal, operation, and key was bound to, or else the one the
  // call picked, bound now, before anything is sent. A bound daemon whose
  // state identity changed, or that left the registry, is unavailable; the
  // key never goes to another daemon. Completed bindings past their
  // retention go first.
  private async claimRoute(
    route: KeyedRoute,
  ): Promise<{ readonly daemon: RegistryDaemon; readonly created: boolean }> {
    const store = this.opts.store;
    const now = this.getNow();

    store.removeExpiredBindings(now);

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
      throw buildConflict(route.key, held.daemon);
    }

    if (held !== null && bound !== undefined && bound !== null && hasLapsedUnanswered(held, now)) {
      const data = held.effectRef === null ? undefined : { effectRef: held.effectRef };

      throw buildGatewayError(
        new DaemonError(
          'outcome_unknown',
          `idempotency key '${route.key}' went to daemon '${held.daemon}' without a known outcome, and that daemon may no longer remember it; check what it did instead of sending it again`,
          data,
        ),
        bound,
        new Map(),
      );
    }

    const daemon = bound ?? route.picked;

    const hello = await requireServingDaemon(this.getCaller, daemon, route.required);

    const binding = store.claimBinding(
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

    // Another gateway call may have bound the key since it was read; the
    // request goes only where the stored binding points.
    if (binding.daemon !== daemon.name) {
      throw buildConflict(route.key, binding.daemon);
    }

    return { daemon, created: held === null };
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
    const ok = await this.opts.pool.getCaller(daemon.name).sendRequest(m, {}, principal, required);

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

function buildConflict(key: string, daemon: string): DaemonError {
  return new DaemonError(
    'idempotency_conflict',
    `idempotency key '${key}' was first used on daemon '${daemon}'`,
  );
}

// Whether a binding whose request never got a known answer has outlived
// the daemon's promise to remember its key: once the daemon's announced
// completed-key retention has passed since the binding was claimed, the
// daemon may have run the request and dropped the key, so a resend could
// run it again. A daemon that announced no retention keeps its keys.
function hasLapsedUnanswered(binding: Readonly<KeyBinding>, now: number): boolean {
  return (
    binding.outcome !== 'completed' &&
    binding.retentionMs !== null &&
    now >= binding.claimedAt + binding.retentionMs
  );
}
