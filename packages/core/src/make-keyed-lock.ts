/**
 * A lock per key: each call runs after every earlier call with the same key
 * has settled, and calls with different keys run at once. A call that throws
 * still releases the key. A key with nothing queued holds no memory.
 */
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
