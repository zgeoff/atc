import { onTestFinished } from 'bun:test';

// The releases the current test registered, in registration order; null
// before its first registration and once its hook has started.
let pending: (() => unknown)[] | null = null;

/**
 * Registers the release of a resource a test just acquired, to run once the
 * current test finishes, and returns that release for the resource's own
 * early release, such as a `stop` member. Every release a test registers
 * runs from one hook, last registered first, so a directory made before a
 * process that lives in it is removed only after that process stops. A
 * release that throws stops none of the others: the hook rethrows once
 * every release has run, as an `AggregateError` when more than one threw.
 * The returned release runs its callback once: every later call, from the
 * hook or from the test, returns what the first call returned. Bun runs the
 * hook after every `afterEach`, so a release works from the paths and
 * handles it captured. Throws outside a test, where nothing would run the
 * hook.
 */
export function registerTestCleanup<T>(release: () => T): () => T {
  let released: { readonly value: T } | null = null;

  const releaseOnce = (): T => {
    released ??= { value: release() };

    return released.value;
  };

  if (pending === null) {
    onTestFinished(releasePending);

    pending = [];
  }

  pending.push(releaseOnce);

  return releaseOnce;
}

async function releasePending(): Promise<void> {
  const releases = pending ?? [];

  pending = null;

  const errors: unknown[] = [];

  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'more than one test cleanup failed');
  }
}
