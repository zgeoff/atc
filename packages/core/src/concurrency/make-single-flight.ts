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
