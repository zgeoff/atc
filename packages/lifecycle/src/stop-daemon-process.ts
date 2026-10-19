import type { Clock } from '@atc/core';
import { waitUntil } from '@atc/core';
import { probeProcessAlive } from './probe-process-alive';

const EXIT_WAIT_MS = 10_000;

export async function stopDaemonProcess(pid: number, clock: Clock): Promise<'exited' | 'killed'> {
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
  return waitUntil(() => !probeProcessAlive(pid), {
    clock,
    intervalMs: 50,
    deadlineMs: clock.now() + EXIT_WAIT_MS,
  });
}
