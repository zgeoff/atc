import { randomUUID } from 'node:crypto';
import type { Clock } from '@atc/core';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import type { DaemonPool } from './create-daemon-pool';
import type { GatewayStore } from './create-gateway-store';
import { GatewayError } from './gateway-error';
import type {
  GatewayRegistry,
  RegistryDaemon,
  RouteNext,
  RoutedCall,
  RoutedOutcome,
} from './types';

interface KeyBindingDeps {
  readonly registry: GatewayRegistry;
  readonly pool: DaemonPool;
  readonly store: GatewayStore;
  readonly clock: Clock;
}

// A keyed call binds its key to one daemon before it leaves, and records the
// daemon's outcome on the binding, so a retry under the key, from this
// gateway process or a later one, goes to the same daemon.
export async function withKeyBinding(
  deps: KeyBindingDeps,
  call: RoutedCall,
  next: RouteNext,
): Promise<RoutedOutcome> {
  const rawKey = call.params['idempotencyKey'];

  const key =
    typeof rawKey === 'string' && PROCEDURE_TRAITS.get(call.method)?.keyed === true ? rawKey : null;

  if (key === null) {
    return next(call);
  }

  const claimed = await claimBinding(deps, call, key);

  let outcome: RoutedOutcome;

  try {
    outcome = await next({
      ...call,
      daemon: claimed.daemon,

      // marks the key sent right before each write, so only the first write under it, across
      // calls and gateway processes, runs; a later one goes out replay-only
      prepareParams: (params) =>
        deps.store.claimFirstSend(call.principal.id, call.method, key, deps.clock.now())
          ? params
          : { ...params, replayOnly: true },
    });
  } catch (error) {
    // a refusal before anything was sent leaves no trace of the key
    if (error instanceof GatewayError) {
      deps.store.removeBinding(call.principal.id, call.method, key, claimed.claimID);
    }

    throw error;
  }

  return recordOutcome(deps, call, key, outcome);
}

async function claimBinding(
  deps: KeyBindingDeps,
  call: RoutedCall,
  key: string,
): Promise<{ readonly daemon: RegistryDaemon; readonly claimID: string }> {
  const picked = call.daemon;

  invariant(picked, 'a keyed call reached its binding before a step picked its daemon');

  // expired bindings go first, so a key past its retention binds afresh
  deps.store.removeExpiredBindings(deps.clock.now());

  const held = deps.store.findBinding(call.principal.id, call.method, key);
  const bound = held === null ? null : deps.registry.daemons.get(held.daemon);

  // a key never moves to another daemon, even when its bound daemon changed or left
  if (held !== null && (bound === undefined || bound?.daemonID !== held.daemonID)) {
    throw new GatewayError(
      'daemon_unavailable',
      `daemon '${held.daemon}', which idempotency key '${key}' went to, now has another state identity`,
      { daemon: held.daemon, reason: 'daemon_changed' },
    );
  }

  if (held !== null && call.named !== null && call.named.name !== held.daemon) {
    throw buildConflict(key, held.daemon);
  }

  const daemon = bound ?? picked;

  const hello = await deps.pool.getCaller(daemon.name).readHello();

  const claimID = randomUUID();

  const binding = deps.store.claimBinding(
    {
      principal: call.principal.id,
      operation: call.method,
      key,
      daemon: daemon.name,
      daemonID: daemon.daemonID,
      retentionMs: hello.retentionMs,
      payloadHash: buildBindingPayloadHash(call.params),
      claimID,
    },
    deps.clock.now(),
  );

  // Another gateway call may have bound the key since it was read; the
  // request goes only where the stored binding points.
  if (binding.daemon !== daemon.name) {
    throw buildConflict(key, binding.daemon);
  }

  return { daemon, claimID };
}

function buildConflict(key: string, daemon: string): DaemonError {
  return new DaemonError(
    'idempotency_conflict',
    `idempotency key '${key}' was first used on daemon '${daemon}'`,
  );
}

// An unknown outcome carries the daemon's id of the effect when any answer
// under the key returned one.
function recordOutcome(
  deps: KeyBindingDeps,
  call: RoutedCall,
  key: string,
  outcome: RoutedOutcome,
): RoutedOutcome {
  return match(outcome)
    .with({ kind: 'answered' }, (answered) => {
      deps.store.updateOutcome(call.principal.id, call.method, key, {
        outcome: 'completed',
        now: deps.clock.now(),
      });

      return answered;
    })
    .with({ kind: 'refused' }, (refused) => {
      const recorded = refused.error.code === 'outcome_unknown' ? 'uncertain' : 'completed';
      const rawRef = refused.error.data?.['effectRef'];
      const effectRef = typeof rawRef === 'string' ? rawRef : null;

      deps.store.updateOutcome(call.principal.id, call.method, key, {
        outcome: recorded,
        now: deps.clock.now(),
        effectRef,
      });

      const held = deps.store.findBinding(call.principal.id, call.method, key);

      if (
        recorded !== 'uncertain' ||
        effectRef !== null ||
        held === null ||
        held.effectRef === null
      ) {
        return refused;
      }

      const error = new DaemonError(refused.error.code, refused.error.message, {
        ...refused.error.data,
        effectRef: held.effectRef,
      });

      return { ...refused, error };
    })
    .exhaustive();
}
