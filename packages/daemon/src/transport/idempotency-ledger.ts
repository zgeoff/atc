import { makeKeyedLock, systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { EffectTarget, IdempotencyRecord, StateStore } from '@atc/store';

// A request's idempotency key, the hash of the payload it came with, the
// principal the request acts as when it is not the ledger's own, and
// whether it only replays a key the ledger already holds.
export interface KeyedRequest {
  readonly key: string;
  readonly payloadHash: string;
  readonly principal?: string;
  readonly replayOnly?: boolean;
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

  // Resolves once the effect is durable; the claim completes only after. A
  // settle that throws leaves the effect standing, so the answer is
  // outcome_unknown and the claim stays held.
  readonly settle: () => Promise<void>;

  // The answer to a retry of a completed key.
  readonly replay: (record: IdempotencyRecord) => T | Promise<T>;

  // The target the effect's session is bound to, recorded with the
  // completed key; absent or null for an effect bound to none.
  readonly findEffectTarget?: (result: T) => EffectTarget | null;
}

// a retry whose effect a stopped daemon may or may not have run answers outcome_unknown with
// the effect id and never starts the effect again
export class IdempotencyLedger {
  private readonly store: StateStore;

  private readonly principal: string;

  // Where a failed write to the ledger is reported, one line at a time.
  private readonly log: (line: string) => void;

  // The time each claim and outcome is stamped with.
  private readonly clock: Clock;

  // One promise chain per key, so two requests under the same key never
  // interleave their claim and completion on one daemon.
  private readonly withKeyLock = makeKeyedLock();

  constructor(
    store: StateStore,
    principal: string,
    log: (line: string) => void,
    clock: Clock = systemClock,
  ) {
    this.store = store;
    this.principal = principal;
    this.log = log;
    this.clock = clock;
  }

  run<T extends Readonly<Record<string, unknown>>>(call: IdempotentCall<T>): Promise<T> {
    const lockKey = JSON.stringify([
      call.keyed.principal ?? this.principal,
      call.operation,
      call.keyed.key,
    ]);

    return this.withKeyLock(lockKey, () => this.runClaimed(call));
  }

  private async runClaimed<T extends Readonly<Record<string, unknown>>>(
    call: IdempotentCall<T>,
  ): Promise<T> {
    const id = {
      principal: call.keyed.principal ?? this.principal,
      operation: call.operation,
      key: call.keyed.key,
    };

    if (call.keyed.replayOnly === true) {
      const found = await this.store.readIdempotencyKey(id);

      if (found === null) {
        throw new DaemonError(
          'idempotency_key_unknown',
          `this daemon holds no ${call.operation} under idempotency key '${call.keyed.key}', so a replay-only request runs nothing`,
        );
      }

      return answerHeldKey(call, found);
    }

    const held = await this.store.claimIdempotencyKey({
      ...id,
      payloadHash: call.keyed.payloadHash,
      effectRef: call.effectRef,
      at: this.clock.now(),
    });

    if (held !== null) {
      return answerHeldKey(call, held);
    }

    let result: T;

    try {
      result = await call.start();
    } catch (error) {
      if (error instanceof EffectRemainsError) {
        this.logFailure(call, 'start', error);

        await this.tryRecordOutcomeUnknown(call, id);

        throw buildOutcomeUnknownError(call, 'failed');
      }

      await this.store.removeIdempotencyKey(id);

      throw error;
    }

    // From here the effect stands. A settle or completion that fails keeps
    // the claim in progress, so a retry answers outcome_unknown rather than
    // running the effect again.
    try {
      await call.settle();
    } catch (error) {
      this.logFailure(call, 'settle', error);

      await this.tryRecordOutcomeUnknown(call, id);

      throw buildOutcomeUnknownError(call, 'could not be made durable');
    }

    try {
      await this.store.updateIdempotencyCompleted(
        id,
        JSON.stringify(result),
        this.clock.now(),
        call.findEffectTarget?.(result) ?? null,
      );
    } catch (error) {
      this.logFailure(call, 'completion write', error);
      throw buildOutcomeUnknownError(call, 'could not be recorded as completed');
    }

    return result;
  }

  // A claim this write fails to update stays in progress, which a retry
  // answers the same way, so the failure is logged and not thrown.
  private async tryRecordOutcomeUnknown(
    call: Pick<IdempotentCall<unknown>, 'operation' | 'keyed' | 'effectRef'>,
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<void> {
    try {
      await this.store.updateIdempotencyOutcomeUnknown(id, this.clock.now());
    } catch (error) {
      this.logFailure(call, 'outcome_unknown write', error);
    }
  }

  // The line holds the operation, key, effect id, the step that failed, and
  // the error, never the request's payload or the effect's result.
  private logFailure(
    call: Pick<IdempotentCall<unknown>, 'operation' | 'keyed' | 'effectRef'>,
    step: string,
    error: unknown,
  ): void {
    const cause =
      error instanceof Error && error.cause instanceof Error ? ` (${String(error.cause)})` : '';

    this.log(
      `atc ${call.operation} under idempotency key '${call.keyed.key}' (effect ${call.effectRef}): ${step} failed: ${String(error)}${cause}`,
    );
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

function buildOutcomeUnknownError(
  call: Pick<IdempotentCall<unknown>, 'operation' | 'keyed' | 'effectRef'>,
  what: string,
): DaemonError {
  return new DaemonError(
    'outcome_unknown',
    `the ${call.operation} under idempotency key '${call.keyed.key}' ${what} and its effect may still stand; check ${call.effectRef} before retrying under a new key`,
    { effectRef: call.effectRef },
  );
}
