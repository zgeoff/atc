export function makeKeyedLock(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();

  return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const before = tails.get(key);
    const turn = Promise.withResolvers<void>();

    tails.set(key, turn.promise);

    try {
      await before;

      return await run();
    } finally {
      turn.resolve();

      if (tails.get(key) === turn.promise) {
        tails.delete(key);
      }
    }
  };
}
