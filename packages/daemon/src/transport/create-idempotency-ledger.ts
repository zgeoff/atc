import { makeKeyedLock, systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { EffectTarget, IdempotencyRecord, StateStore } from '@atc/store';

export interface KeyedRequest {
  readonly key: string;
  readonly payloadHash: string;
  readonly principal?: string;
  readonly replayOnly?: boolean;
}

interface IdempotentCall<T> {
  readonly operation: string;
  readonly keyed: KeyedRequest;

  readonly effectRef: string;

  readonly start: () => T | Promise<T>;

  readonly settle: () => Promise<void>;

  readonly replay: (record: IdempotencyRecord) => T | Promise<T>;

  readonly findEffectTarget?: (result: T) => EffectTarget | null;
}

export interface IdempotencyLedger {
  readonly run: <T extends Readonly<Record<string, unknown>>>(
    call: IdempotentCall<T>,
  ) => Promise<T>;
}

export function createIdempotencyLedger(
  store: StateStore,
  principal: string,
  log: (line: string) => void,
  clock: Clock = systemClock,
): IdempotencyLedger {
  const withKeyLock = makeKeyedLock();

  const logFailure = (
    call: Pick<IdempotentCall<unknown>, 'operation' | 'keyed' | 'effectRef'>,
    step: string,
    error: unknown,
  ): void => {
    const cause =
      error instanceof Error && error.cause instanceof Error ? ` (${String(error.cause)})` : '';

    log(
      `atc ${call.operation} under idempotency key '${call.keyed.key}' (effect ${call.effectRef}): ${step} failed: ${String(error)}${cause}`,
    );
  };

  const tryRecordOutcomeUnknown = async (
    call: Pick<IdempotentCall<unknown>, 'operation' | 'keyed' | 'effectRef'>,
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<void> => {
    try {
      await store.updateIdempotencyOutcomeUnknown(id, clock.now());
    } catch (error) {
      logFailure(call, 'outcome_unknown write', error);
    }
  };

  const runClaimed = async <T extends Readonly<Record<string, unknown>>>(
    call: IdempotentCall<T>,
  ): Promise<T> => {
    const id = {
      principal: call.keyed.principal ?? principal,
      operation: call.operation,
      key: call.keyed.key,
    };

    if (call.keyed.replayOnly === true) {
      const found = await store.readIdempotencyKey(id);

      if (found === null) {
        throw new DaemonError(
          'idempotency_key_unknown',
          `this daemon holds no ${call.operation} under idempotency key '${call.keyed.key}', so a replay-only request runs nothing`,
        );
      }

      return answerHeldKey(call, found);
    }

    const held = await store.claimIdempotencyKey({
      ...id,
      payloadHash: call.keyed.payloadHash,
      effectRef: call.effectRef,
      at: clock.now(),
    });

    if (held !== null) {
      return answerHeldKey(call, held);
    }

    let result: T;

    try {
      result = await call.start();
    } catch (error) {
      if (error instanceof EffectRemainsError) {
        logFailure(call, 'start', error);

        await tryRecordOutcomeUnknown(call, id);

        throw buildOutcomeUnknownError(call, 'failed');
      }

      await store.removeIdempotencyKey(id);

      throw error;
    }

    try {
      await call.settle();
    } catch (error) {
      logFailure(call, 'settle', error);

      await tryRecordOutcomeUnknown(call, id);

      throw buildOutcomeUnknownError(call, 'could not be made durable');
    }

    try {
      await store.updateIdempotencyCompleted(
        id,
        JSON.stringify(result),
        clock.now(),
        call.findEffectTarget?.(result) ?? null,
      );
    } catch (error) {
      logFailure(call, 'completion write', error);
      throw buildOutcomeUnknownError(call, 'could not be recorded as completed');
    }

    return result;
  };

  return {
    run: (call) => {
      const lockKey = JSON.stringify([
        call.keyed.principal ?? principal,
        call.operation,
        call.keyed.key,
      ]);

      return withKeyLock(lockKey, () => runClaimed(call));
    },
  };
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
