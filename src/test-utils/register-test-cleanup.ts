import { onTestFinished } from 'bun:test';

/**
 * Registers the release of a resource a test just acquired, to run once the
 * current test finishes, and returns that release for the resource's own
 * stop and dispose members. The release runs its callback once: every later
 * call, from the hook or from the test, returns what the first call
 * returned, so a resource stopped in the test body is not released again.
 * Bun runs these hooks in the order they were registered and after every
 * `afterEach`, so the callback works from the paths and handles it captured.
 * Throws outside a test, where nothing would run the hook.
 */
export function registerTestCleanup<T>(release: () => T): () => T {
  let released: { readonly value: T } | null = null;

  const releaseOnce = (): T => {
    released ??= { value: release() };

    return released.value;
  };

  onTestFinished(async () => {
    await releaseOnce();
  });

  return releaseOnce;
}
