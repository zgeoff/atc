import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { waitUntil } from '@atc/core/wait-until';
import { isProcessAlive } from './shared/is-process-alive';

const EXIT_WAIT_MS = 10_000;

/**
 * Sends SIGTERM to the daemon and waits up to 10 s for it to exit, then
 * sends SIGKILL when it is still running. Resolves `killed` when SIGKILL was
 * needed and `exited` when SIGTERM was enough. The waits run on the clock.
 */
export async function stopDaemonProcess(
  pid: number,
  clock: Clock = systemClock,
): Promise<'exited' | 'killed'> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'exited';
  }

  const exited = await waitForExit(pid, clock);

  if (exited) {
    return 'exited';
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return 'exited';
  }

  await waitForExit(pid, clock);

  return 'killed';
}

function waitForExit(pid: number, clock: Clock): Promise<boolean> {
  return waitUntil(() => !isProcessAlive(pid), {
    clock,
    intervalMs: 50,
    deadlineMs: clock.now() + EXIT_WAIT_MS,
  });
}
