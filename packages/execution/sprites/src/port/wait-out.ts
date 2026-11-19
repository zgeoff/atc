export async function waitOut(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller sees the failure another way, or none is worth acting on
  }
}
