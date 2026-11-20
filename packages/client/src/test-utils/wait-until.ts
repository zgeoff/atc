import { setTimeout as sleep } from 'node:timers/promises';

// Polls until the check passes, and rethrows its last failure after the timeout.
export async function waitUntil(check: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  for (;;) {
    try {
      check();

      return;
    } catch (error) {
      if (performance.now() >= deadline) {
        throw error;
      }
    }

    await sleep(10);
  }
}
