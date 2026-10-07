interface WaitForOptions {
  /**
   * Milliseconds between retries.
   */
  readonly intervalMs?: number;

  /**
   * Milliseconds before the wait gives up.
   */
  readonly timeoutMs?: number;

  /**
   * The clock the deadline is read from.
   */
  readonly now?: () => number;

  /**
   * Waits out the interval between retries.
   */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Retries the attempt until it stops throwing or rejecting, resolving with
 * its value — so assertion-style checks read exactly as they would in a
 * straight-line test body. Once the deadline passes, the attempt's final
 * failure is rethrown as the wait's rejection.
 */
export async function waitFor<T>(
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 20;
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (now() >= deadline) {
        throw error;
      }
    }

    await wait(intervalMs);
  }
}
