import { onTestFinished } from 'bun:test';

// The releases the current test registered, in registration order; null
// before its first registration and once its hook has started.
let pending: (() => unknown)[] | null = null;

export function registerTestCleanup<T>(release: () => T): () => T {
  let released: { readonly value: T } | null = null;

  const releaseOnce = (): T => {
    released ??= { value: release() };

    return released.value;
  };

  if (pending === null) {
    // Bun runs this hook after every afterEach, so a release works only from the
    // paths and handles it captured.
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

  // Last registered first, so a directory made before a process that lives in it
  // goes only once that process stops.
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
