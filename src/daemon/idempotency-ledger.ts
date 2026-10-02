import { DaemonError } from '../protocol/daemon-error';
import type { IdempotencyRecord } from '../store/idempotency-record';
import type { StateStore } from '../store/state-store';
import { EffectRemainsError } from './effect-remains-error';

// A request's idempotency key, the hash of the payload it came with, and
// the principal the request acts as when it is not the ledger's own.
export interface KeyedRequest {
  readonly key: string;
  readonly payloadHash: string;
  readonly principal?: string;
}

interface IdempotentCall<T> {
  readonly operation: string;
  readonly keyed: KeyedRequest;

  // The id the effect runs under, minted before the claim records it.
  readonly effectRef: string;

  // Starts the effect. A plain throw means nothing took effect, so the claim
  // is dropped for a retry to run fresh; an EffectRemainsError means the
  // effect may still stand, so the claim is kept as outcome_unknown.
  readonly start: () => T | Promise<T>;

  // Resolves once the effect is durable; the claim completes only after.
  readonly settle: () => Promise<void>;

  // The answer to a retry of a completed key.
  readonly replay: (record: IdempotencyRecord) => T | Promise<T>;
}

/**
 * Runs keyed effects at most once per key for each principal: the
 * request's own, else the ledger's. The first
 * request claims the key with its payload's hash and the pre-minted effect
 * id, runs the effect, and completes the key with its answer once the
 * effect is durable. A retry with the same payload replays the completed
 * answer; one with a different payload is `idempotency_conflict`; one whose
 * effect a stopped daemon may or may not have run is `outcome_unknown` with
 * the effect id in `data.effectRef`, and never starts the effect again.
 */
export class IdempotencyLedger {
  private readonly store: StateStore;

  private readonly principal: string;

  // One promise chain per key, so two requests under the same key never
  // interleave their claim and completion on one daemon.
  private readonly locks = new Map<string, Promise<void>>();

  constructor(store: StateStore, principal: string) {
    this.store = store;
    this.principal = principal;
  }

  async run<T extends Readonly<Record<string, unknown>>>(call: IdempotentCall<T>): Promise<T> {
    const lockKey = JSON.stringify([
      call.keyed.principal ?? this.principal,
      call.operation,
      call.keyed.key,
    ]);

    const previous = this.locks.get(lockKey) ?? Promise.resolve();
    const released = Promise.withResolvers<void>();

    const chained = (async () => {
      await previous;
      await released.promise;
    })();

    this.locks.set(lockKey, chained);

    await previous;

    try {
      return await this.runClaimed(call);
    } finally {
      released.resolve();

      if (this.locks.get(lockKey) === chained) {
        this.locks.delete(lockKey);
      }
    }
  }

  private async runClaimed<T extends Readonly<Record<string, unknown>>>(
    call: IdempotentCall<T>,
  ): Promise<T> {
    const id = {
      principal: call.keyed.principal ?? this.principal,
      operation: call.operation,
      key: call.keyed.key,
    };

    const held = await this.store.claimIdempotencyKey({
      ...id,
      payloadHash: call.keyed.payloadHash,
      effectRef: call.effectRef,
      at: Date.now(),
    });

    if (held !== null) {
      return answerHeldKey(call, held);
    }

    let result: T;

    try {
      result = await call.start();
    } catch (error) {
      if (error instanceof EffectRemainsError) {
        await this.store.updateIdempotencyOutcomeUnknown(id, Date.now());

        throw new DaemonError(
          'outcome_unknown',
          `the ${call.operation} under idempotency key '${call.keyed.key}' failed and its effect may still stand; check ${call.effectRef} before retrying under a new key`,
          { effectRef: call.effectRef },
        );
      }

      await this.store.removeIdempotencyKey(id);

      throw error;
    }

    // A settle that fails leaves the claim in progress: the effect started,
    // so the next daemon start marks its outcome unknown rather than letting
    // a retry run it again.
    await call.settle();
    await this.store.updateIdempotencyCompleted(id, JSON.stringify(result), Date.now());

    return result;
  }
}

function answerHeldKey<T>(call: IdempotentCall<T>, held: IdempotencyRecord): T | Promise<T> {
  if (held.payloadHash !== call.keyed.payloadHash) {
    throw new DaemonError(
      'idempotency_conflict',
      `idempotency key '${held.key}' was first used with a different ${held.operation} payload`,
    );
  }

  if (held.state === 'completed') {
    return call.replay(held);
  }

  throw new DaemonError(
    'outcome_unknown',
    `the ${held.operation} under idempotency key '${held.key}' was interrupted and may or may not have taken effect; check ${held.effectRef} before retrying under a new key`,
    { effectRef: held.effectRef },
  );
}
