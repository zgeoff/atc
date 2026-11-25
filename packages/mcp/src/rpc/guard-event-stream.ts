import type { Clock } from '@zgeoff/std';
import type { VerifiedAccess } from '../auth/types';
import { buildRPCError } from './build-rpc-error';

export interface EventStreamGuardOptions {
  readonly clock: Pick<Clock, 'schedule'>;
  readonly verify: (bearer: string) => Promise<VerifiedAccess | null>;
  readonly bearer: string;
  readonly principalID: string;
  readonly signal: AbortSignal | undefined;

  // Frees the stream's place; the guard calls it once, whichever way the stream ends.
  readonly release: () => void;
}

const FAILED = Symbol('failed');

// It verifies its bearer again every minute and ends, with nothing sent after a failed check, when
// the bearer no longer verifies with read, verifies as another principal, or takes too long. It
// frees its place however it ends, an abort before the first read included.
export function guardEventStream(
  source: AsyncIterator<unknown>,
  opts: EventStreamGuardOptions,
): AsyncGenerator<unknown, void, undefined> {
  const failed = Promise.withResolvers<typeof FAILED>();
  const state = { isFailed: false, isFinished: false };

  const stopWatch = startBearerWatch(opts, () => {
    state.isFailed = true;

    failed.resolve(FAILED);
  });

  const finish = (): void => {
    if (state.isFinished) {
      return;
    }

    state.isFinished = true;

    stopWatch();
    opts.signal?.removeEventListener('abort', finish);
    opts.release();
    void closeSource(source);
  };

  if (opts.signal?.aborted === true) {
    finish();
  } else {
    opts.signal?.addEventListener('abort', finish, { once: true });
  }

  return endWhenReturned(relayItems(source, { failed: failed.promise, state, finish }), finish);
}

const RECHECK_MS = 60_000;

function startBearerWatch(opts: EventStreamGuardOptions, onInvalid: () => void): () => void {
  let isStopped = false;
  let cancel: (() => void) | null = null;

  const tick = async (): Promise<void> => {
    const isValid = await probeBearer(opts);

    if (isStopped) {
      return;
    }

    if (!isValid) {
      onInvalid();

      return;
    }

    cancel = opts.clock.schedule(() => {
      void tick();
    }, RECHECK_MS);
  };

  cancel = opts.clock.schedule(() => {
    void tick();
  }, RECHECK_MS);

  return () => {
    isStopped = true;
    cancel?.();
  };
}

const CHECK_TIMEOUT_MS = 10_000;

async function probeBearer(opts: EventStreamGuardOptions): Promise<boolean> {
  const timedOut = Promise.withResolvers<boolean>();

  const cancelTimer = opts.clock.schedule(() => {
    timedOut.resolve(false);
  }, CHECK_TIMEOUT_MS);

  try {
    return await Promise.race([probeVerified(opts), timedOut.promise]);
  } finally {
    cancelTimer();
  }
}

async function probeVerified(opts: EventStreamGuardOptions): Promise<boolean> {
  try {
    const access = await opts.verify(opts.bearer);

    return (
      access !== null && access.scopes.includes('read') && access.clientID === opts.principalID
    );
  } catch {
    return false;
  }
}

async function closeSource(source: AsyncIterator<unknown>): Promise<void> {
  try {
    await source.return?.();
  } catch {
    // the stream already ended, and no one is left to tell
  }
}

// A generator that returns before its first read never runs its body, so its finally never runs.
function endWhenReturned(
  relay: AsyncGenerator<unknown, void, undefined>,
  finish: () => void,
): AsyncGenerator<unknown, void, undefined> {
  const returnRelay = relay.return.bind(relay);

  relay.return = (value) => {
    finish();

    return returnRelay(value);
  };

  return relay;
}

interface RelayOptions {
  readonly failed: Promise<typeof FAILED>;
  readonly state: { readonly isFailed: boolean };
  readonly finish: () => void;
}

async function* relayItems(
  source: AsyncIterator<unknown>,
  relay: RelayOptions,
): AsyncGenerator<unknown, void, undefined> {
  try {
    while (!relay.state.isFailed) {
      const step = await Promise.race([source.next(), relay.failed]);

      if (step === FAILED || step.done === true) {
        return;
      }

      yield step.value;
    }
  } catch (error) {
    throw buildRPCError(error);
  } finally {
    relay.finish();
  }
}
