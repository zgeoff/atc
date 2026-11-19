// Waits out a promise whose failure the caller reads elsewhere or can do nothing about.
export async function waitOut(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller sees the failure another way, or none is worth acting on
  }
}
