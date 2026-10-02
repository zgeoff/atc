/**
 * Wraps an async function so overlapping calls share one run: a call made
 * while a run is in flight gets that run's promise instead of starting
 * another, and the first call after it settles starts a fresh run.
 */
export function makeSingleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  const runAndClear = async (): Promise<T> => {
    try {
      return await run();
    } finally {
      inFlight = null;
    }
  };

  return () => {
    inFlight ??= runAndClear();

    return inFlight;
  };
}
