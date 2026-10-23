interface WaitForOptions {
  readonly intervalMs?: number;

  readonly timeoutMs?: number;

  readonly progress?: () => unknown;

  readonly now?: () => number;

  readonly wait?: (delayMs: number) => Promise<void>;
}

export async function waitFor<T>(
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 20;
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  let deadline = now() + timeoutMs;
  let lastProgress = options.progress?.();

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const progress = options.progress?.();

      if (progress !== lastProgress) {
        lastProgress = progress;
        deadline = now() + timeoutMs;
      } else if (now() >= deadline) {
        throw error;
      }
    }

    await wait(intervalMs);
  }
}
