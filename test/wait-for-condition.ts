/**
 * Polls a condition every 10ms until it reports true. Throws when
 * `timeoutMs` passes first.
 */
export async function waitForCondition(isMet: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!isMet()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for the condition');
    }

    await Bun.sleep(10);
  }
}
