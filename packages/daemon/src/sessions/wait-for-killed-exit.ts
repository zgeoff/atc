import type { HarnessHandle } from '@atc/plugin-api';

// Waits for a killed harness to exit, ending it with a signal it cannot ignore when the first
// wait runs out and its provider can send one.
export async function waitForKilledExit(
  pty: Pick<HarnessHandle, 'waitForExit' | 'killForced'>,
  waitMs: number,
): Promise<boolean> {
  const exited = await pty.waitForExit(waitMs);

  if (exited) {
    return true;
  }

  if (pty.killForced === undefined) {
    return false;
  }

  pty.killForced();

  return pty.waitForExit(waitMs);
}
