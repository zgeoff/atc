export async function waitOut(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {}
}
