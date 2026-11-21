import { waitUntil } from '@atc/core';
import type { Clock } from '@zgeoff/std';
import { probeProcessAlive } from './probe-process-alive';

export async function stopDaemonProcess(
  pid: number,
  clock: Pick<Clock, 'now' | 'schedule'>,
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

const EXIT_WAIT_MS = 10_000;

function waitForExit(pid: number, clock: Pick<Clock, 'now' | 'schedule'>): Promise<boolean> {
  return waitUntil(() => !probeProcessAlive(pid), {
    clock,
    intervalMs: 50,
    deadlineMs: clock.now() + EXIT_WAIT_MS,
  });
}
