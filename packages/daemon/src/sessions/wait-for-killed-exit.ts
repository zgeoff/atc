import type { HarnessHandle } from '@atc/plugin-api';

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
