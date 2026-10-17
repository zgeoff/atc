interface WaitForOptions {
  readonly intervalMs?: number;

  readonly timeoutMs?: number;

  readonly now?: () => number;

  readonly wait?: (ms: number) => Promise<void>;
}

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
